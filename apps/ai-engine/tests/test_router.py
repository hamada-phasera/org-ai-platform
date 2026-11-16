"""LLMRouter のモデル選択と送信前処理（PII マスク・上限超過の降格）。

外部 API は呼ばない（conftest の FakeProvider）。
"""

from __future__ import annotations

import logging

import pytest

import app.llm.router as router
from app.llm.providers.anthropic_provider import MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET
from app.models.llm import ChatMessage
from tests.conftest import Providers


def _msgs(user: str = "hi") -> list[ChatMessage]:
    return [ChatMessage(role="system", content="sys"), ChatMessage(role="user", content=user)]


class TestResolveProviderModel:
    @pytest.mark.parametrize(
        ("plan", "json_mode", "expected"),
        [
            ("STARTER", False, ("gemini", router.GEMINI_UME)),
            ("PRO", False, ("gemini", router.GEMINI_TAKE)),
            ("STARTER", True, ("gemini", router.GEMINI_JSON)),
            ("PRO", True, ("gemini", router.GEMINI_JSON)),
            ("UNKNOWN", False, ("gemini", router.GEMINI_UME)),
            ("MAX", False, ("anthropic", MODEL_OPUS)),
            ("MAX", True, ("anthropic", MODEL_HAIKU)),
        ],
    )
    def test_with_gemini_key(self, with_gemini: None, plan: str, json_mode: bool, expected: tuple[str, str]) -> None:
        assert router.resolve_provider_model(plan, None, json_mode) == expected

    @pytest.mark.parametrize(
        ("plan", "json_mode", "expected"),
        [
            ("STARTER", False, ("anthropic", MODEL_SONNET)),
            ("PRO", False, ("anthropic", MODEL_SONNET)),
            ("MAX", False, ("anthropic", MODEL_OPUS)),
            ("UNKNOWN", False, ("anthropic", MODEL_SONNET)),
            ("STARTER", True, ("anthropic", MODEL_HAIKU)),
        ],
    )
    def test_without_gemini_key_falls_back(
        self, no_gemini: None, plan: str, json_mode: bool, expected: tuple[str, str]
    ) -> None:
        assert router.resolve_provider_model(plan, None, json_mode) == expected

    def test_fallback_warning_is_logged_once(
        self, no_gemini: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setattr(router, "_warned_no_gemini_key", False)
        with caplog.at_level(logging.WARNING, logger="app.llm.router"):
            router.resolve_provider_model("STARTER")
            router.resolve_provider_model("PRO")
        assert caplog.text.count("GEMINI_API_KEY 未設定") == 1

    def test_admin_always_anthropic(self, with_gemini: None, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ADMIN_EMAILS", "Boss@Example.com")
        assert router.resolve_provider_model("STARTER", "  boss@example.COM ") == ("anthropic", MODEL_SONNET)
        assert router.resolve_provider_model("STARTER", "other@example.com")[0] == "gemini"

    @pytest.mark.parametrize("email", [None, ""])
    def test_empty_email_is_not_admin(self, monkeypatch: pytest.MonkeyPatch, email: str | None) -> None:
        monkeypatch.setenv("ADMIN_EMAILS", "a@b.c")
        assert router._is_admin(email) is False


class TestResolveForTask:
    def test_chat_follows_plan(self, with_gemini: None) -> None:
        assert router.resolve_for_task(router.TaskKind.CHAT, "MAX") == ("anthropic", MODEL_OPUS)
        assert router.resolve_for_task(router.TaskKind.CHAT, "STARTER") == ("gemini", router.GEMINI_UME)

    @pytest.mark.parametrize(
        ("kind", "model"),
        [
            (router.TaskKind.SCREEN, MODEL_HAIKU),
            (router.TaskKind.DESIGN, MODEL_OPUS),
            (router.TaskKind.EXTRACT, MODEL_SONNET),
        ],
    )
    def test_fixed_tasks(self, with_gemini: None, kind: router.TaskKind, model: str) -> None:
        for plan in ("STARTER", "PRO", "MAX"):
            assert router.resolve_for_task(kind, plan, "x@y.z", json_mode=True) == ("anthropic", model)

    def test_task_kind_values_are_stable(self) -> None:
        # ログ・外部連携で value を使っている
        assert [k.value for k in router.TaskKind] == ["chat", "screen", "design", "extract"]


@pytest.mark.parametrize(
    ("model", "provider"),
    [("gemini-2.5-flash", "gemini"), (MODEL_SONNET, "anthropic"), ("anything", "anthropic")],
)
def test_provider_of_model(model: str, provider: str) -> None:
    assert router.provider_of_model(model) == provider


class TestScreenUserMessages:
    def test_masks_only_user_messages(self) -> None:
        msgs = [
            ChatMessage(role="system", content="sys a@example.com"),
            ChatMessage(role="assistant", content="a@example.com"),
            ChatMessage(role="user", content="tel 03-1234-5678 / a@example.com"),
        ]
        out, detected, types = router.screen_user_messages(msgs)
        assert detected is True
        assert types == ["EMAIL", "PHONE"]
        assert out[0].content == "sys a@example.com"
        assert out[1].content == "a@example.com"
        assert out[2].content == "tel [PII_PHONE] / [PII_EMAIL]"
        # 元のリストは書き換えない
        assert msgs[2].content == "tel 03-1234-5678 / a@example.com"

    def test_no_pii(self) -> None:
        msgs = _msgs("こんにちは")
        out, detected, types = router.screen_user_messages(msgs)
        assert (detected, types) == (False, [])
        assert out == msgs


class TestChat:
    async def test_routes_to_gemini_for_starter(self, providers: Providers, with_gemini: None) -> None:
        res, detected, _ = await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="STARTER")
        assert providers.gemini.calls and not providers.anthropic.calls
        assert res.model == router.GEMINI_UME
        assert detected is False

    async def test_pii_is_masked_before_sending(self, providers: Providers, no_gemini: None) -> None:
        res, detected, types = await router.llm_router.chat(_msgs("a@example.com"), "GENERAL", "o")
        sent = providers.anthropic.calls[0]["messages"]
        assert sent[1].content == "[PII_EMAIL]"
        assert detected is True and types == ["EMAIL"]
        assert res.pii_detected is True

    async def test_force_anthropic_model(self, providers: Providers, with_gemini: None) -> None:
        res, _, _ = await router.llm_router.chat(_msgs(), "GENERAL", "o", force_anthropic_model=MODEL_OPUS)
        assert providers.anthropic.calls[0]["model"] == MODEL_OPUS
        assert res.model == MODEL_OPUS

    async def test_task_routes_and_passes_json_mode(self, providers: Providers, with_gemini: None) -> None:
        await router.llm_router.chat(_msgs(), "GENERAL", "o", json_mode=True, task=router.TaskKind.SCREEN)
        call = providers.anthropic.calls[0]
        assert (call["model"], call["json_mode"]) == (MODEL_HAIKU, True)

    async def test_degrades_only_chat_when_over_limit(
        self, providers: Providers, no_gemini: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _over(_org: str, _plan: str) -> bool:
            return True

        monkeypatch.setattr(router, "is_over_limit", _over)
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="MAX")
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="MAX", task=router.TaskKind.CHAT)
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="MAX", task=router.TaskKind.DESIGN)
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="MAX", force_anthropic_model=MODEL_OPUS)
        models = [c["model"] for c in providers.anthropic.calls]
        assert models == [MODEL_HAIKU, MODEL_HAIKU, MODEL_OPUS, MODEL_OPUS]

    async def test_degrade_without_gemini_key_uses_haiku(
        self, no_gemini: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _over(_org: str, _plan: str) -> bool:
            return True

        monkeypatch.setattr(router, "is_over_limit", _over)
        assert await router._degrade_if_over_limit("o", "MAX", "anthropic", MODEL_OPUS) == ("anthropic", MODEL_HAIKU)

    async def test_note_call_is_counted(
        self, providers: Providers, no_gemini: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[str] = []
        monkeypatch.setattr(router, "note_call", seen.append)
        await router.llm_router.chat(_msgs(), "GENERAL", "org-9")
        assert seen == ["org-9"]

    async def test_warns_free_tier_when_using_gemini(
        self, providers: Providers, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GEMINI_API_KEY", "k")
        monkeypatch.delenv("GEMINI_PAID_TIER", raising=False)
        monkeypatch.delenv("ADMIN_EMAILS", raising=False)
        called: list[bool] = []
        monkeypatch.setattr(router, "_warn_if_gemini_free_tier", lambda: called.append(True))
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="STARTER")
        await router.llm_router.chat(_msgs(), "GENERAL", "o", plan="MAX")
        assert called == [True]


class TestChatStream:
    async def test_streams_tokens_with_masked_input(self, providers: Providers, no_gemini: None) -> None:
        providers.anthropic.tokens = ["a", "b"]
        out = [t async for t in router.llm_router.chat_stream(_msgs("a@example.com"), "GENERAL", "o")]
        assert out == ["a", "b"]
        call = providers.anthropic.calls[0]
        assert call["kind"] == "stream"
        assert call["messages"][1].content == "[PII_EMAIL]"
        assert call["model"] == MODEL_SONNET

    async def test_stream_degrades_when_over_limit(
        self, providers: Providers, with_gemini: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _over(_org: str, _plan: str) -> bool:
            return True

        monkeypatch.setattr(router, "is_over_limit", _over)
        _ = [t async for t in router.llm_router.chat_stream(_msgs(), "GENERAL", "o", plan="MAX")]
        assert providers.gemini.calls[0]["model"] == router.GEMINI_UME


def test_provider_singletons_are_lazy(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[str] = []

    class _A:
        def __init__(self) -> None:
            created.append("a")

    monkeypatch.setattr(router, "_anthropic", None)
    monkeypatch.setattr(router, "AnthropicProvider", _A)
    first = router._get_anthropic()
    assert router._get_anthropic() is first
    assert created == ["a"]


def test_gemini_singleton_requires_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(router, "_gemini", None)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        router._get_gemini()
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert router._get_gemini() is router._get_gemini()
