"""planner の LLM 出力の検証・正規化（LLM はモック）。"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.llm.router import TaskKind
from app.models.llm import LLMResponse
from app.planner import planner

CAPS: list[dict[str, Any]] = [
    {"name": "send_email", "description": "メール", "inputSchema": {"type": "object"}},
    {"name": "notify_slack", "description": "Slack", "inputSchema": {}},
]


class FakeRouter:
    def __init__(self, reply: str | BaseException) -> None:
        self.reply = reply
        self.calls: list[dict[str, Any]] = []

    async def chat(self, **kwargs: Any) -> tuple[LLMResponse, bool, list[str]]:
        self.calls.append(kwargs)
        if isinstance(self.reply, BaseException):
            raise self.reply
        return LLMResponse(content=self.reply, model="m", tokens_used=0, latency_ms=0, pii_detected=False), False, []


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeRouter:
    r = FakeRouter("{}")
    monkeypatch.setattr(planner, "llm_router", r)
    return r


class TestSafeParseJson:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ('{"a": 1}', {"a": 1}),
            ('```json\n{"a": 1}\n```', {"a": 1}),
            ('```\n{"a": 2}\n```', {"a": 2}),
            ('前置き ```json\n{"a": 3}\n``` 後書き', {"a": 3}),
            ("not json", None),
            ("```json\nbroken\n```", None),
            ("", None),
        ],
    )
    def test_cases(self, raw: str, expected: dict[str, Any] | None) -> None:
        assert planner._safe_parse_json(raw) == expected


class TestPlanCapability:
    async def test_no_capabilities_skips_llm(self, fake: FakeRouter) -> None:
        res = await planner.plan_capability("m", "o", "STARTER", [])
        assert res["capability_name"] is None
        assert res["reasoning"] == "登録済みケイパビリティが 0 件"
        assert fake.calls == []

    async def test_selects_known(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps(
            {"capability_name": "send_email", "args": {"to": "a"}, "confidence": 1, "reasoning": "r"}
        )
        res = await planner.plan_capability("m", "o", "PRO", CAPS, user_email="u@x")
        assert res == {"capability_name": "send_email", "args": {"to": "a"}, "confidence": 1.0, "reasoning": "r"}
        call = fake.calls[0]
        assert call["json_mode"] is True and call["user_email"] == "u@x" and call["plan"] == "PRO"
        assert "task" not in call  # 本文と同じプランのルーティング

    async def test_normalizes_bad_fields(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"capability_name": 123, "args": "x", "confidence": "high", "reasoning": 5})
        res = await planner.plan_capability("m", "o", "PRO", CAPS)
        assert res == {"capability_name": None, "args": {}, "confidence": 0.5, "reasoning": ""}

    async def test_unknown_name(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"capability_name": "ghost"})
        res = await planner.plan_capability("m", "o", "PRO", CAPS)
        assert res["capability_name"] is None
        assert res["inferred_name"] == "ghost"
        assert res["confidence"] == 0.0

    async def test_llm_failure(self, fake: FakeRouter) -> None:
        fake.reply = RuntimeError("boom")
        res = await planner.plan_capability("m", "o", "PRO", CAPS)
        assert res["reasoning"] == "LLM 呼び出し失敗: boom"
        assert res["confidence"] == 0.0

    async def test_unparsable(self, fake: FakeRouter) -> None:
        fake.reply = "x" * 200
        res = await planner.plan_capability("m", "o", "PRO", CAPS)
        assert res["reasoning"] == "LLM 出力の JSON パース失敗: " + "x" * 120


class TestScreenAgent:
    async def test_uses_screen_task(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"repeatable": True, "confidence": 0.9, "reason": "毎週"})
        res = await planner.screen_agent("d", "o", "MAX")
        assert res == {"repeatable": True, "confidence": 0.9, "reason": "毎週"}
        assert fake.calls[0]["task"] is TaskKind.SCREEN

    @pytest.mark.parametrize(
        ("payload", "expected"),
        [
            ({"repeatable": "true", "confidence": 0.9}, {"repeatable": False, "confidence": 0.9, "reason": None}),
            ({"repeatable": True, "confidence": True}, {"repeatable": True, "confidence": 0.0, "reason": None}),
            (
                {"repeatable": True, "confidence": "0.8", "reason": 1},
                {"repeatable": True, "confidence": 0.0, "reason": None},
            ),
        ],
    )
    async def test_strict_types(self, fake: FakeRouter, payload: dict[str, Any], expected: dict[str, Any]) -> None:
        fake.reply = json.dumps(payload)
        assert await planner.screen_agent("d", "o", "MAX") == expected

    async def test_failure_is_false(self, fake: FakeRouter) -> None:
        fake.reply = RuntimeError("x")
        assert await planner.screen_agent("d", "o", "MAX") == {
            "repeatable": False,
            "confidence": 0.0,
            "reason": "判定に失敗しました",
        }

    @pytest.mark.parametrize("reply", ["nope", "[1, 2]"])
    async def test_unreadable_is_false(self, fake: FakeRouter, reply: str) -> None:
        fake.reply = reply
        res = await planner.screen_agent("d", "o", "MAX")
        assert res["repeatable"] is False
        assert res["reason"] == "判定を読み取れませんでした"


class TestPlanAgent:
    async def test_full(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps(
            {
                "name": "weekly",
                "department": "MARKETING",
                "instructions": "do",
                "steps": [
                    {"capabilityName": "notify_slack", "argTemplate": {"text": "{{prev}}"}},
                    {"capabilityName": "send_email", "argTemplate": "bad"},
                    {"capabilityName": "ghost"},
                    "junk",
                ],
                "trigger": "SCHEDULED",
                "confidence": 0.7,
                "reasoning": "r",
            }
        )
        res = await planner.plan_agent("d", "o", "STARTER", CAPS, current_agent={"name": "old", "steps": []})
        assert res == {
            "name": "weekly",
            "department": "MARKETING",
            "instructions": "do",
            "steps": [
                {"capabilityName": "notify_slack", "argTemplate": {"text": "{{prev}}"}},
                {"capabilityName": "send_email", "argTemplate": {}},
            ],
            "trigger": "SCHEDULED",
            "confidence": 0.7,
            "reasoning": "r",
        }
        call = fake.calls[0]
        assert call["task"] is TaskKind.DESIGN
        assert "【修正モード】" in call["messages"][0].content

    async def test_defaults_for_invalid_fields(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"department": "HR", "trigger": "CRON", "steps": "x", "confidence": None})
        res = await planner.plan_agent("d", "o", "STARTER", [])
        assert res["department"] == "GENERAL"
        assert res["trigger"] == "MANUAL"
        assert res["steps"] == []
        assert res["confidence"] == 0.5
        assert res["name"] is None and res["instructions"] is None and res["reasoning"] == ""

    async def test_failure(self, fake: FakeRouter) -> None:
        fake.reply = RuntimeError("x")
        assert await planner.plan_agent("d", "o", "S", []) == {
            "instructions": None,
            "confidence": 0.0,
            "reasoning": "LLM 呼び出し失敗: x",
        }

    async def test_unparsable(self, fake: FakeRouter) -> None:
        fake.reply = "bad"
        res = await planner.plan_agent("d", "o", "S", [])
        assert res["reasoning"] == "LLM 出力の JSON パース失敗: bad"


class TestPlanHttpNode:
    async def test_blanks_secret_values(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps(
            {
                "name": "n",
                "displayName": "N",
                "description": "d",
                "department": "SALES",
                "http": {
                    "method": "POST",
                    "headers": [
                        {"name": "X-Key", "secret": 1, "value": "leak"},
                        {"name": "Accept", "value": None},
                        {"name": 1},
                    ],
                },
                "params": [{"key": "q"}],
                "confidence": 0.9,
                "reasoning": "r",
            }
        )
        res = await planner.plan_http_node("curl", "o", "S")
        assert res["http"] == {
            "method": "POST",
            "headers": [
                {"name": "X-Key", "secret": True, "value": ""},
                {"name": "Accept", "secret": False, "value": ""},
            ],
        }
        assert res["department"] == "SALES"
        assert fake.calls[0]["task"] is TaskKind.DESIGN

    async def test_non_list_headers_become_empty(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"http": {"headers": "x"}, "params": "x", "confidence": "x"})
        res = await planner.plan_http_node("curl", "o", "S")
        assert res["http"] == {"headers": []}
        assert res["params"] == []
        assert res["confidence"] == 0.5

    async def test_missing_http(self, fake: FakeRouter) -> None:
        fake.reply = json.dumps({"http": "x"})
        res = await planner.plan_http_node("curl", "o", "S")
        assert res["http"] is None
        assert res["department"] == "GENERAL"

    async def test_failure_and_unparsable(self, fake: FakeRouter) -> None:
        fake.reply = RuntimeError("x")
        assert (await planner.plan_http_node("c", "o", "S"))["reasoning"] == "LLM 呼び出し失敗: x"
        fake.reply = "bad"
        assert await planner.plan_http_node("c", "o", "S") == {
            "http": None,
            "confidence": 0.0,
            "reasoning": "LLM 出力の JSON パース失敗",
        }
