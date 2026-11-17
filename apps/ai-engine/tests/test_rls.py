"""RLS Phase 2a: AILog / RiskEvent を触る前に、同じセッション（同じトランザクション）で set_config を呼ぶこと。

DB はフェイクのセッション。実 Postgres でのポリシーの効き目は gateway の tests/integration/rls.int.test.ts。
"""

from __future__ import annotations

from typing import Any

import pytest

import app.db
from app.config import settings
from app.governance import audit_logger as al
from app.governance import usage

SET_CONFIG = "SELECT set_config('app.org_id', :org_id, true)"


class _Result:
    def scalar(self) -> int:
        return 3


class RecordingSession:
    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.committed = False

    async def __aenter__(self) -> RecordingSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, stmt: Any, params: dict[str, Any]) -> _Result:
        self.executed.append((" ".join(str(stmt).split()), params))
        return _Result()

    async def commit(self) -> None:
        self.committed = True


@pytest.fixture
def pg(monkeypatch: pytest.MonkeyPatch) -> None:
    """接続先を PostgreSQL に見せる（実際には繋がない）。"""
    monkeypatch.setattr(app.db, "_db_url", "postgresql+asyncpg://u@localhost/flow_x")


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.delenv("RLS_MODE", raising=False)
    usage.reset_cache()
    yield
    usage.reset_cache()


def _log_kwargs(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "org_id": "org-A",
        "department": "SALES",
        "provider": "anthropic",
        "model": "m",
        "input_text": "in",
        "output_text": "out",
        "tokens": 1,
        "latency_ms": 1,
        "pii_detected": True,
        "pii_types": ["EMAIL"],
    }
    base.update(over)
    return base


class TestSetting:
    def test_default_off_and_normalized(self, monkeypatch: pytest.MonkeyPatch) -> None:
        assert settings.rls_mode == "off"
        monkeypatch.setenv("RLS_MODE", "  ON ")
        assert settings.rls_mode == "on"
        monkeypatch.setenv("RLS_MODE", "enforce")
        assert settings.rls_mode == "off"

    def test_applies_only_on_postgres(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RLS_MODE", "on")
        assert app.db.rls_applies("postgresql+asyncpg://u@h/d") is True
        assert app.db.rls_applies("sqlite+aiosqlite:///x.db") is False
        monkeypatch.setenv("RLS_MODE", "off")
        assert app.db.rls_applies("postgresql+asyncpg://u@h/d") is False


class TestSetTenant:
    async def test_on_calls_set_config_with_bound_value(self, monkeypatch: pytest.MonkeyPatch, pg: None) -> None:
        monkeypatch.setenv("RLS_MODE", "on")
        s = RecordingSession()
        await app.db.set_tenant(s, "org-A")
        # 値はバインド変数（SQL に埋め込まない）。is_local=true（SET は使わない）
        assert s.executed == [(SET_CONFIG, {"org_id": "org-A"})]

    async def test_off_does_nothing(self, pg: None) -> None:
        s = RecordingSession()
        await app.db.set_tenant(s, "org-A")
        assert s.executed == []


class TestAuditLogger:
    async def test_on_sets_org_before_inserts_in_same_session(
        self, monkeypatch: pytest.MonkeyPatch, pg: None
    ) -> None:
        monkeypatch.setenv("RLS_MODE", "on")
        s = RecordingSession()
        monkeypatch.setattr(al, "AsyncSessionLocal", lambda: s)
        assert await al.log_llm_call(**_log_kwargs()) is not None
        stmts = [x[0] for x in s.executed]
        assert stmts[0] == SET_CONFIG
        assert s.executed[0][1] == {"org_id": "org-A"}
        assert 'INSERT INTO "AILog"' in stmts[1]
        assert 'INSERT INTO "RiskEvent"' in stmts[2]
        assert stmts.count(SET_CONFIG) == 1
        assert s.committed

    async def test_off_unchanged(self, monkeypatch: pytest.MonkeyPatch, pg: None) -> None:
        s = RecordingSession()
        monkeypatch.setattr(al, "AsyncSessionLocal", lambda: s)
        await al.log_llm_call(**_log_kwargs())
        assert all("set_config" not in x[0] for x in s.executed)


class TestUsage:
    async def test_on_sets_org_before_count(self, monkeypatch: pytest.MonkeyPatch, pg: None) -> None:
        monkeypatch.setenv("RLS_MODE", "on")
        s = RecordingSession()
        monkeypatch.setattr(app.db, "AsyncSessionLocal", lambda: s)
        assert await usage.monthly_calls("org-A") == 3
        assert s.executed[0] == (SET_CONFIG, {"org_id": "org-A"})
        assert 'FROM "AILog"' in s.executed[1][0]
