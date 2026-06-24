from __future__ import annotations
import time
import os
from typing import AsyncIterator, List
from anthropic import (
    AsyncAnthropic,
    APIStatusError,
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from app.models.llm import ChatMessage, LLMResponse


def _is_retryable(exc: BaseException) -> bool:
    """レート制限(429)・過負荷(529)・一時的な接続/タイムアウト/5xx のみリトライ対象にする。
    400 等の恒久的エラーは即時失敗させて無駄な待機を避ける。"""
    if isinstance(exc, (RateLimitError, APIConnectionError, APITimeoutError, InternalServerError)):
        return True
    if isinstance(exc, APIStatusError):
        return getattr(exc, "status_code", 0) in (408, 409, 429, 500, 502, 503, 529)
    return False

MODEL_HAIKU = "claude-haiku-4-5-20251001"
MODEL_SONNET = "claude-sonnet-4-6"
MODEL_OPUS = "claude-opus-4-7"

DEFAULT_MODEL = MODEL_SONNET
MAX_TOKENS = 4096

JSON_MODE_HINT = (
    "\n\n出力は有効な JSON オブジェクト 1 つのみとし、前後に説明文・コードブロックを含めないこと。"
)


def _split_system_and_messages(messages: List[ChatMessage]) -> tuple[str, list[dict]]:
    system_parts: list[str] = []
    user_messages: list[dict] = []
    for m in messages:
        if m.role == "system":
            system_parts.append(m.content)
        else:
            user_messages.append({"role": m.role, "content": m.content})
    return "\n".join(system_parts).strip(), user_messages


class AnthropicProvider:
    def __init__(self) -> None:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.client = AsyncAnthropic(api_key=api_key) if api_key else None

    @retry(
        retry=retry_if_exception(_is_retryable),
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1.5, min=2, max=30),
        reraise=True,
    )
    async def chat(
        self,
        messages: List[ChatMessage],
        model: str = DEFAULT_MODEL,
        json_mode: bool = False,
    ) -> LLMResponse:
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        start = time.monotonic()

        system_content, user_messages = _split_system_and_messages(messages)
        if json_mode:
            system_content = (system_content + JSON_MODE_HINT).strip()

        response = await self.client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system_content if system_content else "",
            messages=user_messages,
        )
        latency_ms = int((time.monotonic() - start) * 1000)
        content = ""
        if response.content:
            for block in response.content:
                # text blocks のみ抽出（tool_use 等はスキップ）
                if getattr(block, "type", None) == "text":
                    content += block.text
        tokens = (response.usage.input_tokens + response.usage.output_tokens) if response.usage else 0
        return LLMResponse(
            content=content,
            model=model,
            tokens_used=tokens,
            latency_ms=latency_ms,
            pii_detected=False,
        )

    async def chat_stream(
        self,
        messages: List[ChatMessage],
        model: str = DEFAULT_MODEL,
    ) -> AsyncIterator[str]:
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        system_content, user_messages = _split_system_and_messages(messages)
        async with self.client.messages.stream(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system_content if system_content else "",
            messages=user_messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
