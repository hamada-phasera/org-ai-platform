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


def _with_cache(system_content: str, user_messages: list[dict]):
    """プロンプトキャッシュ: システムプロンプト＋会話プレフィックス（直近メッセージまで）を
    cache_control でキャッシュ対象にする。マルチターンで累積する入力の再送コストを削減（入力50-90%減）。
    最小キャッシュ長(約1024トークン)未満なら API 側で無視されるため、短い場合も安全に素通しする。"""
    system_param = (
        [{"type": "text", "text": system_content, "cache_control": {"type": "ephemeral"}}]
        if system_content
        else ""
    )
    api_messages = [dict(m) for m in user_messages]
    if api_messages:
        last = api_messages[-1]
        content = last.get("content")
        if isinstance(content, str):
            last["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
    return system_param, api_messages


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

        system_param, api_messages = _with_cache(system_content, user_messages)
        response = await self.client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system_param,
            messages=api_messages,
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

    @retry(
        retry=retry_if_exception(_is_retryable),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    async def vision_json(
        self,
        *,
        system: str,
        prompt: str,
        image_base64: str,
        media_type: str,
        model: str = MODEL_SONNET,
    ) -> LLMResponse:
        """画像から構造化データを読み取る（領収書の読み取り専用）。

        ⚠️ 画像はここで一度使うだけで、こちらでもゲートウェイでも保存しない。
        保管すると電子帳簿保存法の保管要件を背負うことになるため、v1 では持たない。

        json_mode の指示は system 側に足す（chat() と同じ流儀）。
        """
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        start = time.monotonic()

        response = await self.client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=(system + JSON_MODE_HINT).strip(),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_base64,
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        latency_ms = int((time.monotonic() - start) * 1000)
        content = ""
        if response.content:
            for block in response.content:
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
        system_param, api_messages = _with_cache(system_content, user_messages)
        async with self.client.messages.stream(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system_param,
            messages=api_messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
