"""X-Org-Id と body の org_id の照合（docs/design/multi-tenancy.md §11.7 P1〜P6）。

LLM は FakeProvider、AILog の書き込みは記録だけのスタブ（conftest / test_main_api と同じ流儀）。
"""

from __future__ import annotations

import ast
import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
from app import tenancy
from app.governance import audit_logger as al
from tests.conftest import Providers

LLM_BODY = {"messages": [{"role": "user", "content": "hi"}], "department": "SALES", "org_id": "org-A"}


@pytest.fixture
def logged(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    monkeypatch.setattr(main, "schedule_llm_log", lambda **kw: records.append(kw))
    return records


@pytest.fixture
def client(providers: Providers, no_gemini: None, logged: list[dict[str, Any]]) -> TestClient:
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _default_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ORG_HEADER_MODE", raising=False)


class TestHttp:
    def test_p1_header_and_body_match(self, client: TestClient, logged: list[dict[str, Any]]) -> None:
        res = client.post("/llm/chat", json=LLM_BODY, headers={"x-org-id": "org-A"})
        assert res.status_code == 200
        assert logged[0]["org_id"] == "org-A"

    @pytest.mark.parametrize("mode", ["warn", "enforce"])
    def test_p2_mismatch_is_rejected(
        self,
        client: TestClient,
        logged: list[dict[str, Any]],
        providers: Providers,
        monkeypatch: pytest.MonkeyPatch,
        mode: str,
    ) -> None:
        monkeypatch.setenv("ORG_HEADER_MODE", mode)
        res = client.post("/llm/chat", json=LLM_BODY, headers={"x-org-id": "org-B"})
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "ORG_MISMATCH"
        # LLM も呼ばず、記録も残さない
        assert providers.anthropic.calls == []
        assert logged == []

    def test_p3_missing_header_enforce_rejects(
        self, client: TestClient, providers: Providers, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ORG_HEADER_MODE", "enforce")
        res = client.post("/llm/chat", json=LLM_BODY)
        assert res.status_code == 403
        assert providers.anthropic.calls == []

    def test_p3_missing_header_warn_passes_with_warning(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="app.tenancy"):
            res = client.post("/llm/chat", json=LLM_BODY)
        assert res.status_code == 200
        assert any("X-Org-Id がありません" in r.getMessage() for r in caplog.records)

    def test_off_ignores_everything(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ORG_HEADER_MODE", "off")
        assert client.post("/llm/chat", json=LLM_BODY, headers={"x-org-id": "org-B"}).status_code == 200

    def test_invalid_mode_falls_back_to_warn(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ORG_HEADER_MODE", "strict-ish")
        assert tenancy.org_header_mode() == "warn"
        assert client.post("/llm/chat", json=LLM_BODY).status_code == 200
        assert client.post("/llm/chat", json=LLM_BODY, headers={"x-org-id": "org-B"}).status_code == 403

    def test_p4_wrong_internal_token_still_401(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "INTERNAL_API_TOKEN", "tok")
        res = client.post("/llm/chat", json=LLM_BODY, headers={"x-org-id": "org-A", "x-internal-token": "nope"})
        assert res.status_code == 401

    def test_orchestrate_mismatch_rejected(self, client: TestClient) -> None:
        res = client.post("/orchestrate", json={"message": "hi", "org_id": "org-A"}, headers={"x-org-id": "org-B"})
        assert res.status_code == 403


class TestBindOrg:
    def test_sets_current_org(self) -> None:
        token = tenancy.current_org_header.set("org-A")
        try:
            assert tenancy.bind_org("org-A") == "org-A"
            assert tenancy.current_org.get() == "org-A"
        finally:
            tenancy.current_org_header.reset(token)

    def test_mismatch_raises(self) -> None:
        token = tenancy.current_org_header.set("org-A")
        try:
            with pytest.raises(HTTPException) as e:
                tenancy.bind_org("org-B")
            assert e.value.status_code == 403
        finally:
            tenancy.current_org_header.reset(token)


class FakeSession:
    def __init__(self) -> None:
        self.executed: list[Any] = []

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, stmt: Any, params: dict[str, Any]) -> None:
        self.executed.append(params)

    async def commit(self) -> None:
        return None


def test_p5_audit_log_refuses_other_org(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakeSession()
    monkeypatch.setattr(al, "AsyncSessionLocal", lambda: session)

    async def run() -> str | None:
        tenancy.current_org.set("org-A")
        return await al.log_llm_call(
            org_id="org-B",
            department="SALES",
            provider="p",
            model="m",
            input_text="i",
            output_text="o",
            tokens=1,
            latency_ms=1,
            pii_detected=False,
            pii_types=[],
        )

    assert asyncio.run(run()) is None
    assert session.executed == []


def test_p5_audit_log_writes_same_org(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakeSession()
    monkeypatch.setattr(al, "AsyncSessionLocal", lambda: session)

    async def run() -> str | None:
        tenancy.current_org.set("org-A")
        return await al.log_llm_call(
            org_id="org-A",
            department="SALES",
            provider="p",
            model="m",
            input_text="i",
            output_text="o",
            tokens=1,
            latency_ms=1,
            pii_detected=False,
            pii_types=[],
        )

    assert asyncio.run(run()) is not None
    assert len(session.executed) == 1


ENDPOINTS = {
    "orchestrate",
    "orchestrate_stream",
    "llm_chat",
    "plan",
    "rank",
    "read_receipt_endpoint",
    "plan_http_node_endpoint",
    "plan_agent_endpoint",
}


def test_p6_every_org_endpoint_calls_bind_org_first() -> None:
    """main.py を AST で読み、org_id を受け取るエンドポイントが最初の文で bind_org を呼んでいることを確かめる。"""
    tree = ast.parse(Path(main.__file__).read_text(encoding="utf-8"))
    found: dict[str, bool] = {}
    for node in tree.body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        is_post = any(
            isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "post"
            for d in node.decorator_list
        )
        if not is_post:
            continue
        body = [s for s in node.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
        first = body[0]
        calls_bind = (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Call)
            and isinstance(first.value.func, ast.Name)
            and first.value.func.id == "bind_org"
        )
        found[node.name] = calls_bind
    assert set(found) == ENDPOINTS, "POST エンドポイントが増えたら bind_org を呼び、ここに足すこと"
    assert all(found.values()), {k: v for k, v in found.items() if not v}
