"""プロバイダ実装の変換・リトライ判定・API 呼び出しの組み立て（ネットワークには出ない）。"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from tenacity import wait_none

from app.llm.providers import anthropic_provider as ap
from app.llm.providers import gemini_provider as gp
from app.llm.providers.common import JSON_MODE_HINT, MAX_TOKENS
from app.models.llm import ChatMessage

MSGS = [
    ChatMessage(role="system", content="s1"),
    ChatMessage(role="system", content="s2"),
    ChatMessage(role="user", content="u1"),
    ChatMessage(role="assistant", content="a1"),
    ChatMessage(role="user", content="u2"),
]


def _bare(cls: type[BaseException], **attrs: Any) -> BaseException:
    """SDK の例外を __init__ を通さずに作る（本物の SDK・テスト用スタブのどちらでも動く）。"""
    exc = cls.__new__(cls)
    for k, v in attrs.items():
        setattr(exc, k, v)
    return exc


# ── Anthropic ─────────────────────────────────────────────────────


class TestAnthropicHelpers:
    def test_split_system_and_messages(self) -> None:
        system, msgs = ap._split_system_and_messages(MSGS)
        assert system == "s1\ns2"
        assert msgs == [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "u2"},
        ]

    def test_with_cache_marks_system_and_last_message(self) -> None:
        original = [{"role": "user", "content": "u1"}, {"role": "user", "content": "u2"}]
        system, msgs = ap._with_cache("sys", original)
        assert system == [{"type": "text", "text": "sys", "cache_control": {"type": "ephemeral"}}]
        assert msgs[0] == {"role": "user", "content": "u1"}
        assert msgs[1]["content"] == [{"type": "text", "text": "u2", "cache_control": {"type": "ephemeral"}}]
        assert original[1]["content"] == "u2"  # 入力は書き換えない

    def test_with_cache_empty(self) -> None:
        assert ap._with_cache("", []) == ("", [])

    @pytest.mark.parametrize("name", ["RateLimitError", "APIConnectionError", "APITimeoutError", "InternalServerError"])
    def test_retryable_error_types(self, name: str) -> None:
        assert ap._is_retryable(_bare(getattr(ap, name))) is True

    @pytest.mark.parametrize(
        ("status", "expected"), [(429, True), (529, True), (503, True), (400, False), (401, False)]
    )
    def test_status_based_retry(self, status: int, expected: bool) -> None:
        assert ap._is_retryable(_bare(ap.APIStatusError, status_code=status)) is expected

    def test_other_errors_not_retried(self) -> None:
        assert ap._is_retryable(ValueError("x")) is False

    def test_to_llm_response_joins_text_blocks(self) -> None:
        response = SimpleNamespace(
            content=[
                SimpleNamespace(type="text", text="a"),
                SimpleNamespace(type="tool_use", text="ignored"),
                SimpleNamespace(type="text", text="b"),
            ],
            usage=SimpleNamespace(input_tokens=3, output_tokens=4),
        )
        res = ap._to_llm_response(response, "m", start=0.0)
        assert (res.content, res.model, res.tokens_used, res.pii_detected) == ("ab", "m", 7, False)
        assert res.latency_ms >= 0

    def test_to_llm_response_handles_empty(self) -> None:
        res = ap._to_llm_response(SimpleNamespace(content=None, usage=None), "m", start=0.0)
        assert (res.content, res.tokens_used) == ("", 0)


class _FakeStream:
    def __init__(self, tokens: list[str]) -> None:
        self._tokens = tokens

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    @property
    def text_stream(self) -> Any:
        async def gen() -> Any:
            for t in self._tokens:
                yield t

        return gen()


class _FakeMessages:
    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes = outcomes
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return _FakeStream(["x", "y"])


def _ok_response(text: str = "done") -> Any:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)], usage=SimpleNamespace(input_tokens=1, output_tokens=2)
    )


@pytest.fixture
def anthropic(monkeypatch: pytest.MonkeyPatch) -> tuple[ap.AnthropicProvider, _FakeMessages]:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    provider = ap.AnthropicProvider()
    messages = _FakeMessages([_ok_response()])
    provider.client = SimpleNamespace(messages=messages)  # type: ignore[assignment]
    # リトライの待ち時間を 0 に（テストを遅くしない）
    for fn in (ap.AnthropicProvider.chat, ap.AnthropicProvider.vision_json):
        monkeypatch.setattr(fn.retry, "wait", wait_none())  # type: ignore[attr-defined]
    return provider, messages


class TestAnthropicProvider:
    def test_without_key_client_is_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        assert ap.AnthropicProvider().client is None

    async def test_chat_without_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        provider = ap.AnthropicProvider()
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY is not set"):
            await provider.chat(MSGS)
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY is not set"):
            await provider.vision_json(system="s", prompt="p", image_base64="AA", media_type="image/png")
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY is not set"):
            _ = [t async for t in provider.chat_stream(MSGS)]

    async def test_chat_builds_request(self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]) -> None:
        provider, messages = anthropic
        res = await provider.chat(MSGS, model="m1")
        call = messages.calls[0]
        assert call["model"] == "m1"
        assert call["max_tokens"] == MAX_TOKENS
        assert call["system"][0]["text"] == "s1\ns2"
        assert len(call["messages"]) == 3
        assert (res.content, res.tokens_used, res.model) == ("done", 3, "m1")

    async def test_chat_json_mode_appends_hint(self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]) -> None:
        provider, messages = anthropic
        await provider.chat(MSGS, json_mode=True)
        assert messages.calls[0]["system"][0]["text"] == ("s1\ns2" + JSON_MODE_HINT).strip()
        assert messages.calls[0]["model"] == ap.DEFAULT_MODEL

    async def test_chat_retries_transient_errors(self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]) -> None:
        provider, messages = anthropic
        messages.outcomes = [_bare(ap.APIStatusError, status_code=529), _ok_response("after-retry")]
        res = await provider.chat(MSGS)
        assert res.content == "after-retry"
        assert len(messages.calls) == 2

    async def test_chat_does_not_retry_permanent_errors(
        self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]
    ) -> None:
        provider, messages = anthropic
        err = _bare(ap.APIStatusError, status_code=400)
        messages.outcomes = [err, _ok_response()]
        with pytest.raises(ap.APIStatusError):
            await provider.chat(MSGS)
        assert len(messages.calls) == 1

    async def test_vision_json(self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]) -> None:
        provider, messages = anthropic
        res = await provider.vision_json(system="sys", prompt="p", image_base64="AAAA", media_type="image/png")
        call = messages.calls[0]
        assert call["system"] == ("sys" + JSON_MODE_HINT).strip()
        content = call["messages"][0]["content"]
        assert content[0]["source"] == {"type": "base64", "media_type": "image/png", "data": "AAAA"}
        assert content[1] == {"type": "text", "text": "p"}
        assert call["model"] == ap.MODEL_SONNET
        assert res.content == "done"

    async def test_chat_stream(self, anthropic: tuple[ap.AnthropicProvider, _FakeMessages]) -> None:
        provider, messages = anthropic
        out = [t async for t in provider.chat_stream(MSGS, model="m")]
        assert out == ["x", "y"]
        assert messages.calls[0]["model"] == "m"


# ── Gemini ────────────────────────────────────────────────────────


class TestGeminiHelpers:
    def test_payload(self) -> None:
        payload = gp._to_gemini_payload(MSGS, json_mode=False)
        assert payload == {
            "contents": [
                {"role": "user", "parts": [{"text": "u1"}]},
                {"role": "model", "parts": [{"text": "a1"}]},
                {"role": "user", "parts": [{"text": "u2"}]},
            ],
            "generationConfig": {"maxOutputTokens": MAX_TOKENS},
            "systemInstruction": {"parts": [{"text": "s1\ns2"}]},
        }

    def test_payload_json_mode(self) -> None:
        payload = gp._to_gemini_payload([ChatMessage(role="user", content="u")], json_mode=True)
        assert payload["generationConfig"]["responseMimeType"] == "application/json"
        assert payload["systemInstruction"]["parts"][0]["text"] == JSON_MODE_HINT.strip()

    def test_payload_without_system(self) -> None:
        payload = gp._to_gemini_payload([ChatMessage(role="user", content="u")], json_mode=False)
        assert "systemInstruction" not in payload

    @pytest.mark.parametrize(
        ("data", "text"),
        [
            ({}, ""),
            ({"candidates": []}, ""),
            ({"candidates": [{"content": {"parts": [{"text": "a"}, {"text": "b"}, {}]}}]}, "ab"),
            ({"candidates": [{}]}, ""),
        ],
    )
    def test_extract_text(self, data: dict[str, Any], text: str) -> None:
        assert gp._extract_text(data) == text

    def test_retryable(self) -> None:
        req = httpx.Request("POST", "https://x.test")
        assert gp._is_retryable(httpx.ConnectError("x")) is True
        assert gp._is_retryable(httpx.ReadTimeout("x")) is True
        for status, expected in ((429, True), (500, True), (400, False), (404, False)):
            err = httpx.HTTPStatusError("e", request=req, response=httpx.Response(status, request=req))
            assert gp._is_retryable(err) is expected
        assert gp._is_retryable(ValueError()) is False


@pytest.fixture
def gemini_transport(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """httpx.AsyncClient を MockTransport 付きに差し替える（外部には出ない）。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith(":streamGenerateContent"):
            body = (
                'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}\n\n'
                "data: not-json\n\n"
                ": comment\n\n"
                "data: [DONE]\n\n"
                'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]}}]}\n\n'
            )
            return httpx.Response(200, text=body)
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "{}"}]}}], "usageMetadata": {"totalTokenCount": 9}},
        )

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    return seen


class TestGeminiProvider:
    def test_requires_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
            gp.GeminiProvider()

    async def test_chat(self, gemini_transport: list[httpx.Request]) -> None:
        res = await gp.GeminiProvider().chat(MSGS, model="gemini-x", json_mode=True)
        req = gemini_transport[0]
        assert req.url.path == "/v1beta/models/gemini-x:generateContent"
        assert req.headers["x-goog-api-key"] == "gk"
        assert json.loads(req.content)["generationConfig"]["responseMimeType"] == "application/json"
        assert (res.content, res.tokens_used, res.model) == ("{}", 9, "gemini-x")

    async def test_chat_stream(self, gemini_transport: list[httpx.Request]) -> None:
        out = [t async for t in gp.GeminiProvider().chat_stream(MSGS, model="gemini-x")]
        assert out == ["he", "llo"]
        assert gemini_transport[0].url.params["alt"] == "sse"
