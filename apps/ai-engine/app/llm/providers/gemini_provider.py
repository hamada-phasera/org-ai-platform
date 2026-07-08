from __future__ import annotations
import json
import os
import time
import logging
from typing import AsyncIterator, List

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from app.models.llm import ChatMessage, LLMResponse

logger = logging.getLogger(__name__)

# Google AI Studio (Generative Language API) — 無料キーで利用可能な v1beta REST。
# SDK を増やさず httpx 直叩き（requirements 変更なし）。
_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# 松竹梅のうち 梅/竹 用の既定モデル（env で上書き可）。
# 無料枠の RPM/RPD を考慮し、梅=flash-lite（最も寛い枠）、竹=flash（上位品質）。
MODEL_UME = os.getenv("GEMINI_MODEL_UME", "gemini-2.5-flash-lite")
MODEL_TAKE = os.getenv("GEMINI_MODEL_TAKE", "gemini-2.5-flash")
# 構造化処理（json_mode: 意図分類・capability選択等）は常に最安モデルで十分。
MODEL_JSON = os.getenv("GEMINI_MODEL_JSON", MODEL_UME)

MAX_TOKENS = 4096

JSON_MODE_HINT = (
    "\n\n出力は有効な JSON オブジェクト 1 つのみとし、前後に説明文・コードブロックを含めないこと。"
)


def _is_retryable(exc: BaseException) -> bool:
    """429（無料枠レート制限）・一時的な接続/タイムアウト/5xx のみリトライ。4xx は即時失敗。"""
    if isinstance(exc, (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (408, 409, 429, 500, 502, 503, 529)
    return False


def _to_gemini_payload(messages: List[ChatMessage], json_mode: bool) -> dict:
    """ChatMessage 列を Gemini generateContent ボディへ変換。
    - system ロールは systemInstruction に集約
    - assistant → model / user → user
    """
    system_parts: list[str] = []
    contents: list[dict] = []
    for m in messages:
        if m.role == "system":
            system_parts.append(m.content)
        else:
            role = "model" if m.role == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m.content}]})

    system_text = "\n".join(system_parts).strip()
    if json_mode:
        system_text = (system_text + JSON_MODE_HINT).strip()

    payload: dict = {
        "contents": contents,
        "generationConfig": {"maxOutputTokens": MAX_TOKENS},
    }
    if system_text:
        payload["systemInstruction"] = {"parts": [{"text": system_text}]}
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"
    return payload


def _extract_text(data: dict) -> str:
    candidates = data.get("candidates") or []
    if not candidates:
        return ""
    parts = (candidates[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts)


class GeminiProvider:
    """AnthropicProvider と同一インターフェース（chat / chat_stream）の Gemini 実装。"""

    def __init__(self) -> None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY が未設定です")
        self._headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    @retry(
        retry=retry_if_exception(_is_retryable),
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        reraise=True,
    )
    async def chat(
        self,
        messages: List[ChatMessage],
        model: str = MODEL_UME,
        json_mode: bool = False,
    ) -> LLMResponse:
        payload = _to_gemini_payload(messages, json_mode)
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.post(
                f"{_BASE_URL}/models/{model}:generateContent",
                headers=self._headers,
                json=payload,
            )
            res.raise_for_status()
            data = res.json()
        latency_ms = int((time.monotonic() - start) * 1000)
        usage = data.get("usageMetadata") or {}
        return LLMResponse(
            content=_extract_text(data),
            model=model,
            tokens_used=int(usage.get("totalTokenCount") or 0),
            latency_ms=latency_ms,
            pii_detected=False,  # router 側で PII 判定結果を上書きする（Anthropic 実装と同じ流儀）
        )

    async def chat_stream(
        self,
        messages: List[ChatMessage],
        model: str = MODEL_UME,
    ) -> AsyncIterator[str]:
        """SSE ストリーミング（:streamGenerateContent?alt=sse）。トークン断片を逐次 yield。"""
        payload = _to_gemini_payload(messages, json_mode=False)
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                "POST",
                f"{_BASE_URL}/models/{model}:streamGenerateContent",
                params={"alt": "sse"},
                headers=self._headers,
                json=payload,
            ) as res:
                res.raise_for_status()
                async for line in res.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    chunk = line[len("data:"):].strip()
                    if not chunk or chunk == "[DONE]":
                        continue
                    try:
                        piece = _extract_text(json.loads(chunk))
                    except json.JSONDecodeError:
                        continue
                    if piece:
                        yield piece
