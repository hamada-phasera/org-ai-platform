from __future__ import annotations
import logging
import os
from typing import AsyncIterator, List, Optional, Tuple
from app.models.llm import ChatMessage, LLMResponse
from app.governance.pii_screener import screen
from app.llm.providers.anthropic_provider import (
    AnthropicProvider,
    MODEL_HAIKU,
    MODEL_SONNET,
    MODEL_OPUS,
)
from app.llm.providers.gemini_provider import (
    GeminiProvider,
    MODEL_UME as GEMINI_UME,
    MODEL_TAKE as GEMINI_TAKE,
    MODEL_JSON as GEMINI_JSON,
)

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────
# 松竹梅ルーティング:
#   梅 = STARTER → Gemini（flash-lite 系, 無料枠）
#   竹 = PRO     → Gemini（flash 系, 無料枠の上位モデル）
#   松 = MAX     → Anthropic Claude（従来通り Sonnet/Opus）
#   admin（ADMIN_EMAILS に一致する user_email）→ 常に Anthropic
#   GEMINI_API_KEY 未設定 → 全プラン Anthropic に安全フォールバック（起動を壊さない）
#   エージェント構築（/plan/agent）→ 全ユーザー Anthropic Opus（force_anthropic_model）
# ──────────────────────────────────────────────────────────────

# 自由記述の「本文生成」用モデル（品質重視）。STARTER でも Sonnet を下限にし、MAX は Opus。
_PLAN_CONTENT_MODEL = {
    "STARTER": MODEL_SONNET,
    "PRO": MODEL_SONNET,
    "MAX": MODEL_OPUS,
}

# Gemini 側の本文生成モデル（梅/竹）。
_PLAN_GEMINI_MODEL = {
    "STARTER": GEMINI_UME,
    "PRO": GEMINI_TAKE,
}

# エージェント構築は頻度が低く 1 回の品質が資産になるため、全ユーザー Opus 固定。
AGENT_BUILD_MODEL = MODEL_OPUS

_anthropic: AnthropicProvider | None = None
_gemini: GeminiProvider | None = None
_warned_no_gemini_key = False


def _get_anthropic() -> AnthropicProvider:
    global _anthropic
    if _anthropic is None:
        _anthropic = AnthropicProvider()
    return _anthropic


def _get_gemini() -> GeminiProvider:
    global _gemini
    if _gemini is None:
        _gemini = GeminiProvider()
    return _gemini


def _admin_emails() -> set[str]:
    raw = os.getenv("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _is_admin(user_email: Optional[str]) -> bool:
    return bool(user_email) and user_email.strip().lower() in _admin_emails()


def resolve_provider_model(
    plan: str,
    user_email: Optional[str] = None,
    json_mode: bool = False,
) -> Tuple[str, str]:
    """(provider_name, model) を返す唯一の決定点。AILog の provider/model 記録にも使う。
    - admin / 松(MAX) → anthropic（json_mode=Haiku, 本文=plan準拠）
    - 梅(STARTER)・竹(PRO) → gemini（json_mode=最安, 本文=梅flash-lite/竹flash）
    - GEMINI_API_KEY 無し → anthropic に安全フォールバック
    """
    global _warned_no_gemini_key
    if _is_admin(user_email) or plan == "MAX":
        model = MODEL_HAIKU if json_mode else _PLAN_CONTENT_MODEL.get(plan, MODEL_SONNET)
        return "anthropic", model

    if not os.getenv("GEMINI_API_KEY"):
        if not _warned_no_gemini_key:
            logger.warning(
                "[LLMRouter] GEMINI_API_KEY 未設定のため 梅/竹 プランも Anthropic にフォールバックします"
            )
            _warned_no_gemini_key = True
        model = MODEL_HAIKU if json_mode else _PLAN_CONTENT_MODEL.get(plan, MODEL_SONNET)
        return "anthropic", model

    model = GEMINI_JSON if json_mode else _PLAN_GEMINI_MODEL.get(plan, GEMINI_UME)
    return "gemini", model


def provider_of_model(model: str) -> str:
    """モデル名から provider 名を導出（AILog 記録用）。"""
    return "gemini" if model.startswith("gemini") else "anthropic"


def _resolve_model(plan: str, json_mode: bool = False) -> str:
    """後方互換: Anthropic 前提の旧ヘルパ（main.py のログ用途で残置）。"""
    if json_mode:
        return MODEL_HAIKU
    return _PLAN_CONTENT_MODEL.get(plan, MODEL_SONNET)


def _screen_user_messages(messages: List[ChatMessage]) -> Tuple[List[ChatMessage], bool, List[str]]:
    pii_detected = False
    pii_types: List[str] = []
    screened = list(messages)
    for i, msg in enumerate(screened):
        if msg.role == "user":
            result = screen(msg.content)
            if result.detected:
                pii_detected = True
                pii_types.extend(result.types)
                screened[i] = ChatMessage(role=msg.role, content=result.text)
    return screened, pii_detected, pii_types


class LLMRouter:
    async def chat(
        self,
        messages: List[ChatMessage],
        department: str,
        org_id: str,
        plan: str = "STARTER",
        json_mode: bool = False,
        user_email: Optional[str] = None,
        force_anthropic_model: Optional[str] = None,
    ) -> Tuple[LLMResponse, bool, List[str]]:
        screened_messages, pii_detected, pii_types = _screen_user_messages(messages)

        if force_anthropic_model:
            # エージェント構築など「全ユーザーで Claude 品質」を明示する経路
            provider_name, model = "anthropic", force_anthropic_model
        else:
            provider_name, model = resolve_provider_model(plan, user_email, json_mode)

        provider = _get_gemini() if provider_name == "gemini" else _get_anthropic()
        response = await provider.chat(screened_messages, model=model, json_mode=json_mode)
        logger.info(f"[LLMRouter] plan={plan} admin={_is_admin(user_email)} -> {provider_name} ({response.model})")
        response.pii_detected = pii_detected
        return response, pii_detected, pii_types

    async def chat_stream(
        self,
        messages: List[ChatMessage],
        department: str,
        org_id: str,
        plan: str = "STARTER",
        user_email: Optional[str] = None,
    ) -> AsyncIterator[str]:
        """Stream tokens with PII screening applied to user messages（プロバイダは松竹梅で分岐）。"""
        screened_messages, _, _ = _screen_user_messages(messages)
        provider_name, model = resolve_provider_model(plan, user_email, json_mode=False)
        provider = _get_gemini() if provider_name == "gemini" else _get_anthropic()
        async for token in provider.chat_stream(screened_messages, model=model):
            yield token


llm_router = LLMRouter()
