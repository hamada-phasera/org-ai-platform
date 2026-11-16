"""共通フィクスチャ。

⚠️ ネットワーク・DB には一切出ない。LLM プロバイダは FakeProvider に差し替え、
   利用量（DB の count）と AILog 書き込みはモックする。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.models.llm import ChatMessage, LLMResponse


@dataclass
class FakeProvider:
    """AnthropicProvider / GeminiProvider と同じ口を持つテスト用プロバイダ。"""

    name: str = "fake"
    reply: str | Callable[[list[ChatMessage]], str] = "ok"
    tokens: list[str] = field(default_factory=lambda: ["he", "llo"])
    error: BaseException | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)

    def _content(self, messages: list[ChatMessage]) -> str:
        return self.reply(messages) if callable(self.reply) else self.reply

    async def chat(self, messages: list[ChatMessage], model: str = "", json_mode: bool = False) -> LLMResponse:
        self.calls.append({"kind": "chat", "messages": messages, "model": model, "json_mode": json_mode})
        if self.error is not None:
            raise self.error
        return LLMResponse(
            content=self._content(messages), model=model, tokens_used=7, latency_ms=3, pii_detected=False
        )

    async def chat_stream(self, messages: list[ChatMessage], model: str = "") -> AsyncIterator[str]:
        self.calls.append({"kind": "stream", "messages": messages, "model": model})
        if self.error is not None:
            raise self.error
        for t in self.tokens:
            yield t

    async def vision_json(self, **kwargs: Any) -> LLMResponse:
        self.calls.append({"kind": "vision", **kwargs})
        if self.error is not None:
            raise self.error
        return LLMResponse(
            content=self._content([]), model=kwargs.get("model", ""), tokens_used=1, latency_ms=1, pii_detected=False
        )


@dataclass
class Providers:
    anthropic: FakeProvider
    gemini: FakeProvider


@pytest.fixture
def providers(monkeypatch: pytest.MonkeyPatch) -> Providers:
    """router のプロバイダ取得を Fake に差し替え、利用量の DB 参照を止める。"""
    import app.llm.router as router

    p = Providers(anthropic=FakeProvider(name="anthropic"), gemini=FakeProvider(name="gemini"))
    monkeypatch.setattr(router, "_get_anthropic", lambda: p.anthropic)
    monkeypatch.setattr(router, "_get_gemini", lambda: p.gemini)

    async def _not_over(_org: str, _plan: str) -> bool:
        return False

    monkeypatch.setattr(router, "is_over_limit", _not_over)
    return p


@pytest.fixture
def no_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)


@pytest.fixture
def with_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_PAID_TIER", "true")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)
