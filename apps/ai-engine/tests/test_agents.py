"""部署エージェントのメッセージ組み立てと、意図分類・オーケストレータ。"""

from __future__ import annotations

from typing import Any

import pytest

from app.agents import base
from app.agents.accounting import AccountingAgent
from app.agents.general import GeneralAgent
from app.agents.sales import SalesAgent
from app.models.llm import ChatMessage
from app.orchestrator import orchestrator as orch
from app.orchestrator.intent_classifier import classify_intent
from tests.conftest import Providers


class TestHelpers:
    def test_sanitize_history_filters_roles_and_caps(self) -> None:
        history = [ChatMessage(role="system", content="x")] + [
            ChatMessage(role="user", content=str(i)) for i in range(12)
        ]
        out = base._sanitize_history(history)
        assert [m.content for m in out] == [str(i) for i in range(2, 12)]

    def test_sanitize_history_truncates_long_items(self) -> None:
        out = base._sanitize_history([ChatMessage(role="assistant", content="a" * 13_000)])
        assert out[0].content == "a" * 12_000 + "\n[truncated]"

    def test_wrap_user_message(self) -> None:
        assert base._wrap_user_message("hi") == "<user_query>\nhi\n</user_query>"
        wrapped = base._wrap_user_message("b" * 17_000)
        assert wrapped == "<user_query>\n" + "b" * 16_000 + "\n[truncated]\n</user_query>"

    def test_build_system_prompt(self) -> None:
        out = base._build_system_prompt("BASE", "  EXTRA  ")
        assert out == "\n\n".join(
            ["BASE", base.SECURITY_CORE, base.AGENTIZATION_HINT, base.DELIVERABLE_HEARING, "EXTRA"]
        )
        assert base._build_system_prompt("BASE", "   ").endswith(base.DELIVERABLE_HEARING)


class TestBuildMessages:
    def test_without_context(self) -> None:
        msgs = SalesAgent().build_messages("q")
        assert [m.role for m in msgs] == ["system", "user"]
        assert msgs[0].content.startswith(SalesAgent.system_prompt)
        assert SalesAgent.security_extra.strip() in msgs[0].content
        assert base.GROUNDING_INSTRUCTION not in msgs[0].content

    @pytest.mark.parametrize("context", [None, "", "   "])
    def test_blank_context_is_ignored(self, context: str | None) -> None:
        assert len(GeneralAgent().build_messages("q", context=context)) == 2

    def test_with_context_and_history(self) -> None:
        msgs = AccountingAgent().build_messages(
            "q", history=[ChatMessage(role="user", content="h")], context="\n資料\n"
        )
        assert [m.role for m in msgs] == ["system", "system", "user", "user"]
        assert msgs[0].content.endswith(base.GROUNDING_INSTRUCTION)
        assert msgs[1].content == "【参考資料】\n資料"
        assert msgs[2].content == "h"

    async def test_execute_passes_department(self, providers: Providers, no_gemini: None) -> None:
        res, _, _ = await AccountingAgent().execute("q", "o", plan="PRO", user_email=None)
        assert res.content == "ok"
        assert providers.anthropic.calls[0]["messages"][-1].content == "<user_query>\nq\n</user_query>"


class TestIntentClassifier:
    @pytest.mark.parametrize(
        ("message", "dept"),
        [
            ("顧客への提案書を作って", "SALES"),
            ("Instagram の投稿案", "MARKETING"),
            ("今月の経費と領収書", "ACCOUNTING"),
            ("KPI のダッシュボード", "ANALYTICS"),
            ("こんにちは", "GENERAL"),
        ],
    )
    async def test_keywords(self, message: str, dept: str) -> None:
        assert await classify_intent(message) == dept

    async def test_tie_prefers_first_department(self) -> None:
        # 営業(SALES) と 経理(ACCOUNTING) が 1 点ずつ → 定義順で先の SALES
        assert await classify_intent("営業 経理") == "SALES"


class TestOrchestrator:
    async def test_resolve_department(self) -> None:
        assert await orch.resolve_department("経費", "SALES") == "SALES"
        assert await orch.resolve_department("経費", "HR") == "ACCOUNTING"
        assert await orch.resolve_department("経費", None) == "ACCOUNTING"

    def test_get_agent_falls_back_to_general(self) -> None:
        assert isinstance(orch.get_agent("HR"), GeneralAgent)
        assert isinstance(orch.get_agent("SALES"), SalesAgent)

    async def test_process_logs_call(
        self, providers: Providers, no_gemini: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        logged: list[dict[str, Any]] = []
        monkeypatch.setattr(orch, "schedule_llm_log", lambda **kw: logged.append(kw))
        res = await orch.orchestrator.process("経費まとめ", "org-1")
        assert res.department == "ACCOUNTING"
        assert logged[0]["department"] == "ACCOUNTING"
        assert logged[0]["tokens"] == 7
        assert logged[0]["provider"] == "anthropic"
