from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from enum import Enum

from app.config import settings
from app.governance.pii_screener import screen
from app.governance.usage import is_over_limit, note_call
from app.llm.providers.anthropic_provider import (
    MODEL_HAIKU,
    MODEL_OPUS,
    MODEL_SONNET,
    AnthropicProvider,
)
from app.llm.providers.gemini_provider import (
    MODEL_JSON as GEMINI_JSON,
)
from app.llm.providers.gemini_provider import (
    MODEL_TAKE as GEMINI_TAKE,
)
from app.llm.providers.gemini_provider import (
    MODEL_UME as GEMINI_UME,
)
from app.llm.providers.gemini_provider import (
    GeminiProvider,
)
from app.models.llm import ChatMessage, LLMResponse

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

# ──────────────────────────────────────────────────────────────
# タスクの性質によるモデル選択
#
# 「プランで決める」だけだと、判定のような安く済む処理まで高いモデルで回ってしまう。
# 実際、エージェント化提案は「この会話は定型業務か」の判定と「エージェントの設計」を
# 一度に Opus でやっていて、確信度が低い大半のケースでは設計結果を捨てていた。
# 何をさせるかで段を分ける。ここが唯一の決定点。
# ──────────────────────────────────────────────────────────────


class TaskKind(str, Enum):  # noqa: UP042 — StrEnum にすると str()/format() の結果が変わる
    """LLM に何をさせるか。"""

    CHAT = "chat"
    """本文生成。顧客に見える品質なのでプランに従う。"""

    SCREEN = "screen"
    """判定・分類。はい/いいえに深い推論は要らないので最安で足りる。"""

    DESIGN = "design"
    """エージェント・外部APIノードの設計。頻度が低く、1回の質が資産として残る。"""

    EXTRACT = "extract"
    """画像・文書からの値の抽出。読み違いがトークン代より高くつくので中位を使う。"""


# エージェント構築は頻度が低く 1 回の品質が資産になるため、全ユーザー Opus 固定。
AGENT_BUILD_MODEL = MODEL_OPUS

# 判定は品質差が出にくく、回数が多い。全プラン最安固定。
SCREEN_MODEL = MODEL_HAIKU

# 抽出は金額・日付を読むので、安すぎるモデルにしない。全プラン固定。
EXTRACT_MODEL = MODEL_SONNET


def resolve_for_task(
    kind: TaskKind,
    plan: str,
    user_email: str | None = None,
    json_mode: bool = False,
) -> tuple[str, str]:
    """タスクの性質からプロバイダとモデルを決める。

    CHAT だけがプランに従い、ほかは全プラン共通。
    共通にしているのは、判定・設計・抽出の品質を顧客のプランで変えると
    「安いプランだと領収書を読み違える」ような、値段では説明できない差になるため。
    """
    if kind is TaskKind.SCREEN:
        return "anthropic", SCREEN_MODEL
    if kind is TaskKind.DESIGN:
        return "anthropic", AGENT_BUILD_MODEL
    if kind is TaskKind.EXTRACT:
        return "anthropic", EXTRACT_MODEL
    return resolve_provider_model(plan, user_email, json_mode)

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


def _is_admin(user_email: str | None) -> bool:
    return bool(user_email) and user_email.strip().lower() in settings.admin_emails


def resolve_provider_model(
    plan: str,
    user_email: str | None = None,
    json_mode: bool = False,
) -> tuple[str, str]:
    """(provider_name, model) を返す唯一の決定点。AILog の provider/model 記録にも使う。
    - admin / 松(MAX) → anthropic（json_mode=Haiku, 本文=plan準拠）
    - 梅(STARTER)・竹(PRO) → gemini（json_mode=最安, 本文=梅flash-lite/竹flash）
    - GEMINI_API_KEY 無し → anthropic に安全フォールバック
    """
    global _warned_no_gemini_key
    if _is_admin(user_email) or plan == "MAX":
        model = MODEL_HAIKU if json_mode else _PLAN_CONTENT_MODEL.get(plan, MODEL_SONNET)
        return "anthropic", model

    if not settings.gemini_api_key:
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


def _screen_user_messages(messages: list[ChatMessage]) -> tuple[list[ChatMessage], bool, list[str]]:
    pii_detected = False
    pii_types: list[str] = []
    screened = list(messages)
    for i, msg in enumerate(screened):
        if msg.role == "user":
            result = screen(msg.content)
            if result.detected:
                pii_detected = True
                pii_types.extend(result.types)
                screened[i] = ChatMessage(role=msg.role, content=result.text)
    return screened, pii_detected, pii_types


_warned_free_tier = False


def _warn_if_gemini_free_tier() -> None:
    """無料枠のまま有料のお客さまを乗せていないか、起動後1回だけ知らせる。

    ⚠️ Gemini の無料枠は「入力が Google の製品改善に使われる」と明記されている。
       領収書や LINE のやり取りを扱う以上、有料プランの土台にはできない。
       有料課金に切り替えたら GEMINI_PAID_TIER=true を設定する（設定し忘れの検知用）。
    """
    global _warned_free_tier
    if _warned_free_tier:
        return
    if settings.gemini_paid_tier:
        return
    _warned_free_tier = True
    logger.warning(
        "[LLMRouter] Gemini を無料枠の設定で使っています。無料枠の入力は Google の製品改善に"
        "使われるため、有料のお客さまを乗せる前に有料課金へ切り替え、GEMINI_PAID_TIER=true を設定してください"
    )


async def _degrade_if_over_limit(
    org_id: str, plan: str, provider_name: str, model: str
) -> tuple[str, str]:
    """当月の上限を超えていたら、いちばん軽いモデルに落とす（止めない）。

    ⚠️ 落とすのは本文生成だけ。判定・抽出・設計は用途でモデルを固定してあり、
       ここを落とすと領収書の読み違いのような「値段では説明できない劣化」になる。
    """
    if not await is_over_limit(org_id, plan):
        return provider_name, model
    cheap = ("gemini", GEMINI_UME) if settings.gemini_api_key else ("anthropic", MODEL_HAIKU)
    if (provider_name, model) == cheap:
        return provider_name, model
    logger.warning(
        "[LLMRouter] org=%s は当月の上限を超えています。%s -> %s に落として継続します",
        org_id, model, cheap[1],
    )
    return cheap


class LLMRouter:
    async def chat(
        self,
        messages: list[ChatMessage],
        department: str,
        org_id: str,
        plan: str = "STARTER",
        json_mode: bool = False,
        user_email: str | None = None,
        force_anthropic_model: str | None = None,
        task: TaskKind | None = None,
    ) -> tuple[LLMResponse, bool, list[str]]:
        screened_messages, pii_detected, pii_types = _screen_user_messages(messages)

        if force_anthropic_model:
            # エージェント構築など「全ユーザーで Claude 品質」を明示する経路
            provider_name, model = "anthropic", force_anthropic_model
        elif task is not None:
            provider_name, model = resolve_for_task(task, plan, user_email, json_mode)
        else:
            provider_name, model = resolve_provider_model(plan, user_email, json_mode)

        # 本文生成だけ、上限超過で軽いモデルへ落とす
        if force_anthropic_model is None and task in (None, TaskKind.CHAT):
            provider_name, model = await _degrade_if_over_limit(org_id, plan, provider_name, model)

        if provider_name == "gemini":
            _warn_if_gemini_free_tier()
        provider = _get_gemini() if provider_name == "gemini" else _get_anthropic()
        response = await provider.chat(screened_messages, model=model, json_mode=json_mode)
        note_call(org_id)
        logger.info(
            f"[LLMRouter] task={task.value if task else '-'} plan={plan} "
            f"admin={_is_admin(user_email)} -> {provider_name} ({response.model})"
        )
        response.pii_detected = pii_detected
        return response, pii_detected, pii_types

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        department: str,
        org_id: str,
        plan: str = "STARTER",
        user_email: str | None = None,
    ) -> AsyncIterator[str]:
        """Stream tokens with PII screening applied to user messages（プロバイダは松竹梅で分岐）。"""
        screened_messages, _, _ = _screen_user_messages(messages)
        provider_name, model = resolve_provider_model(plan, user_email, json_mode=False)
        provider_name, model = await _degrade_if_over_limit(org_id, plan, provider_name, model)
        note_call(org_id)
        if provider_name == "gemini":
            _warn_if_gemini_free_tier()
        provider = _get_gemini() if provider_name == "gemini" else _get_anthropic()
        async for token in provider.chat_stream(screened_messages, model=model):
            yield token


llm_router = LLMRouter()
