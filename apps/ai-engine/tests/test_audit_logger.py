"""AILog / RiskEvent の記録（DB はフェイクのセッション）。"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.governance import audit_logger as al


class FakeSession:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.committed = False

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, stmt: Any, params: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("db down")
        self.executed.append((str(stmt), params))

    async def commit(self) -> None:
        self.committed = True


@pytest.fixture
def session(monkeypatch: pytest.MonkeyPatch) -> FakeSession:
    s = FakeSession()
    monkeypatch.setattr(al, "AsyncSessionLocal", lambda: s)
    return s


def _kwargs(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "org_id": "org-1",
        "department": "SALES",
        "provider": "anthropic",
        "model": "m",
        "input_text": "in",
        "output_text": "out",
        "tokens": 10,
        "latency_ms": 5,
        "pii_detected": False,
        "pii_types": [],
    }
    base.update(over)
    return base


class TestRiskScore:
    @pytest.mark.parametrize(
        ("detected", "types", "score"),
        [
            (False, ["CREDIT_CARD"], 0.0),
            (True, [], 0.0),
            (True, ["EMAIL"], 0.2),
            (True, ["PHONE"], 0.2),
            (True, ["MY_NUMBER"], 0.5),
            (True, ["CREDIT_CARD"], 0.6),
            (True, ["CREDIT_CARD", "MY_NUMBER", "EMAIL", "PHONE"], 1.0),
            (True, ["CREDENTIAL"], 0.1),
        ],
    )
    def test_scores(self, detected: bool, types: list[str], score: float) -> None:
        assert al._calc_risk_score(detected, types, None) == pytest.approx(score)


class TestLogLLMCall:
    async def test_writes_ailog_only_without_pii(self, session: FakeSession) -> None:
        log_id = await al.log_llm_call(**_kwargs())
        assert log_id is not None
        assert len(session.executed) == 1
        sql, params = session.executed[0]
        assert 'INSERT INTO "AILog"' in sql
        assert params["id"] == log_id
        assert params["risk_score"] == 0.0
        assert session.committed

    async def test_truncates_long_text(self, session: FakeSession) -> None:
        await al.log_llm_call(**_kwargs(input_text="a" * 5000, output_text=None))
        params = session.executed[0][1]
        assert len(params["input_text"]) == 4000
        assert params["output_text"] == ""

    @pytest.mark.parametrize(("types", "severity"), [(["EMAIL"], "MEDIUM"), (["CREDIT_CARD"], "HIGH")])
    async def test_writes_risk_event_with_pii(self, session: FakeSession, types: list[str], severity: str) -> None:
        log_id = await al.log_llm_call(**_kwargs(pii_detected=True, pii_types=types))
        assert len(session.executed) == 2
        sql, params = session.executed[1]
        assert 'INSERT INTO "RiskEvent"' in sql
        assert params["ai_log_id"] == log_id
        assert params["severity"] == severity
        assert params["description"] == f"PII detected and masked: {', '.join(types)}"

    async def test_db_failure_is_swallowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(al, "AsyncSessionLocal", lambda: FakeSession(fail=True))
        assert await al.log_llm_call(**_kwargs()) is None


class TestScheduleLLMLog:
    async def test_runs_in_background_and_keeps_reference(self, session: FakeSession) -> None:
        task = al.schedule_llm_log(**_kwargs())
        assert task in al._background_tasks
        log_id = await task
        await asyncio.sleep(0)  # done_callback を回す
        assert log_id is not None
        assert task not in al._background_tasks
        assert session.executed
