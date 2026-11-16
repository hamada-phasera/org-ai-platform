import json
import logging
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from dotenv import load_dotenv

# ⚠️ 他の app.* より先に .env を読む。import 時に env を読んで定数にするモジュールがある
#    （CORS の許可オリジン・内部トークン・Gemini のモデル名・DB の接続先）。
load_dotenv()

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from app.config import settings
from app.departments import DEFAULT_DEPARTMENT
from app.governance.audit_logger import schedule_llm_log
from app.governance.pii_screener import PIIResult, screen
from app.llm.router import (
    AGENT_BUILD_MODEL,
    EXTRACT_MODEL,
    llm_router,
    provider_of_model,
    resolve_provider_model,
    screen_user_messages,
)
from app.models.api import (
    ALLOWED_RECEIPT_MEDIA_TYPES,
    MAX_RECEIPT_IMAGE_BYTES,
    AgentStep,
    PlanAgentRequest,
    PlanAgentResponse,
    PlanHttpNodeRequest,
    PlanHttpNodeResponse,
    PlanRequest,
    PlanResponse,
    Ranking,
    RankRequest,
    RankResponse,
    ReadReceiptRequest,
    ReadReceiptResponse,
)
from app.models.llm import ChatMessage, LLMRequest, LLMResponse, OrchestateRequest, OrchestrateResponse
from app.orchestrator.orchestrator import get_agent, orchestrator, resolve_department
from app.planner import plan_agent, plan_capability
from app.planner.planner import plan_http_node, screen_agent
from app.planner.receipt_vision import read_receipt
from app.tenancy import ORG_HEADER, bind_org, current_org_header

logger = logging.getLogger(__name__)

APP_VERSION = "1.0.0"

app = FastAPI(title="AI Engine", version=APP_VERSION)

allowed_origins = settings.allowed_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 内部呼び出しの共有シークレット ────────────────────────────────
#
# ⚠️ ai-engine は Render の `type: web` で **公開 URL を持つ**。認証が1つも無いと、
#    URL を知っている第三者が /llm/chat や /vision/receipt を直接叩ける:
#      * Anthropic の課金がこちら持ちで発生する（画像入力は特に単価が高い）
#      * org_id は検証しないので、他組織の id で AILog に行を書き込める
#    CORS はブラウザ向けなので curl には効かない。共有シークレットで塞ぐ。
#
# INTERNAL_API_TOKEN が未設定なら素通しする。gateway 側も未設定なら送らないので、
# 「片方だけ先にデプロイして全部落ちる」ことがない。**設定して初めて有効になる**。
INTERNAL_API_TOKEN = settings.internal_api_token

# 認証を求めないパス（Render のヘルスチェックと、ドキュメント類）
PUBLIC_PATHS = frozenset({"/health", "/docs", "/redoc", "/openapi.json"})

if not INTERNAL_API_TOKEN:
    logger.warning(
        "[ai-engine] ⚠️ INTERNAL_API_TOKEN が未設定です。"
        "公開 URL の全エンドポイントが無認証で叩けます（課金・AILog 汚染のリスク）。"
        "gateway と同じ値を設定してください。"
    )


@app.middleware("http")
async def require_internal_token(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """gateway 以外からの呼び出しを弾く。"""
    # ⚠️ CORS プリフライト(OPTIONS)にはカスタムヘッダが載らないので通す（本体は弾かれる）
    if INTERNAL_API_TOKEN and request.url.path not in PUBLIC_PATHS and request.method != "OPTIONS":
        provided = request.headers.get("x-internal-token", "")
        if not secrets.compare_digest(provided, INTERNAL_API_TOKEN):
            # ⚠️ 理由を細かく返さない（トークンの有無を推測させない）
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
    # どの組織としての呼び出しか（gateway が付ける）。照合は各エンドポイントの bind_org で行う
    current_org_header.set(request.headers.get(ORG_HEADER) or None)
    return await call_next(request)


# ── 共通ヘルパ ────────────────────────────────────────────────────


def _utc_timestamp() -> str:
    """タイムゾーン表記なしの UTC ISO 8601（従来の datetime.utcnow().isoformat() と同じ形）。"""
    return datetime.now(UTC).replace(tzinfo=None).isoformat()


def _pii_types(result: PIIResult) -> list[str]:
    return list(result.types) if result.detected else []


def _log_masked_call(
    *,
    org_id: str,
    department: str,
    provider: str,
    model: str,
    pii_result: PIIResult,
    result: dict[str, Any],
) -> None:
    """planner 系エンドポイントの AILog 記録。入力は**マスク後**だけを残す。"""
    schedule_llm_log(
        org_id=org_id,
        department=department,
        provider=provider,
        model=model,
        input_text=pii_result.text,
        output_text=json.dumps(result, ensure_ascii=False),
        tokens=None,
        latency_ms=None,
        pii_detected=pii_result.detected,
        pii_types=_pii_types(pii_result),
    )


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# ── エンドポイント ────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-engine",
        "version": APP_VERSION,
        "timestamp": _utc_timestamp(),
    }


@app.get("/ready")
async def ready() -> dict:
    has_key = bool(settings.anthropic_api_key)
    has_gemini = bool(settings.gemini_api_key)
    return {
        "status": "ok" if has_key else "degraded",
        "anthropic": has_key,
        # 松竹梅ルーティング: 梅/竹=Gemini。未設定なら全プラン Anthropic フォールバック
        "gemini": has_gemini,
        "admin_emails_configured": bool(settings.admin_emails_raw),
        "timestamp": _utc_timestamp(),
    }


@app.post("/orchestrate", response_model=OrchestrateResponse)
async def orchestrate(request: OrchestateRequest) -> OrchestrateResponse:
    bind_org(request.org_id)
    try:
        return await orchestrator.process(
            user_message=request.message,
            org_id=request.org_id,
            plan=request.plan,
            department=request.department,
            context=request.context,
            history=request.history,
            user_email=request.user_email,
        )
    except RuntimeError as e:
        msg = str(e)
        if "ANTHROPIC_API_KEY" in msg:
            raise HTTPException(status_code=503, detail=msg) from e
        raise


@app.post("/orchestrate/stream")
async def orchestrate_stream(request: OrchestateRequest) -> StreamingResponse:
    """SSE ストリーミングエンドポイント。トークンを1つずつ返す。"""
    bind_org(request.org_id)
    resolved_dept = await resolve_department(request.message, request.department)

    # /orchestrate と同じ組み立て（セキュリティ核 + エージェント化提案を含む統一ビルダ経由）
    agent = get_agent(resolved_dept)
    messages = agent.build_messages(request.message, history=request.history, context=request.context)

    # PII スクリーニング（LLMRouter と同じ関数。router 側でも送信直前にもう一度かかる）
    messages, pii_detected, pii_types = screen_user_messages(messages)

    # ⚠️ AILog には **マスク後** だけを残す。request.message を直接記録すると、
    #    LLM には送っていない生の資格情報・個人情報が DB に永久に残る。
    logged_input = "\n".join(m.content for m in messages if m.role == "user")

    async def event_generator() -> AsyncIterator[str]:
        start = time.monotonic()
        full_content = ""
        # 最初に部署情報を送信
        yield _sse({"type": "department", "department": resolved_dept})
        try:
            stream_provider, stream_model = resolve_provider_model(request.plan, request.user_email)
            async for token in llm_router.chat_stream(
                messages=messages,
                department=resolved_dept,
                org_id=request.org_id,
                plan=request.plan,
                user_email=request.user_email,
            ):
                full_content += token
                yield _sse({"type": "token", "content": token})

            latency_ms = int((time.monotonic() - start) * 1000)
            # 完了イベント
            yield _sse({"type": "done", "department": resolved_dept})

            # 監査ログを非同期で記録
            schedule_llm_log(
                org_id=request.org_id,
                department=resolved_dept,
                provider=stream_provider,
                model=stream_model,
                input_text=logged_input,  # マスク後だけを記録する
                output_text=full_content,
                tokens=None,
                latency_ms=latency_ms,
                pii_detected=pii_detected,
                pii_types=pii_types,
            )
        except Exception as e:
            yield _sse({"type": "error", "message": str(e)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/llm/chat", response_model=LLMResponse)
async def llm_chat(request: LLMRequest) -> LLMResponse:
    bind_org(request.org_id)
    response, pii_detected, pii_types = await llm_router.chat(
        messages=request.messages,
        department=request.department,
        org_id=request.org_id,
        plan=request.plan,
        json_mode=request.json_mode,
        user_email=request.user_email,
    )
    # 監査ログ: /llm/chat を直接叩く経路（ゲートウェイ /api/llm/chat・各部署の生成機能）も
    # 必ず AILog / RiskEvent に残す。CLAUDE.md「すべての AI 入出力を AILog に記録」・
    # integration-requests 営業#5（/plan・/orchestrate と同様に集中ロギング）。
    # ⚠️ router 側で LLM へ送る前にマスクしているが、ここで記録するのは request の生テキスト。
    #    同じ screen() を通してからでないと、AILog にだけ平文が残る。
    input_text = screen("\n".join(m.content for m in request.messages if m.role == "user")).text
    schedule_llm_log(
        org_id=request.org_id,
        department=request.department,
        provider=provider_of_model(response.model),
        model=response.model,
        input_text=input_text,
        output_text=response.content,
        tokens=response.tokens_used,
        latency_ms=response.latency_ms,
        pii_detected=pii_detected,
        pii_types=pii_types,
    )
    return response


@app.post("/plan", response_model=PlanResponse)
async def plan(request: PlanRequest) -> PlanResponse:
    bind_org(request.org_id)
    pii_result = screen(request.message)
    capabilities = [c.model_dump() for c in request.available_capabilities]
    result = await plan_capability(
        message=pii_result.text,
        org_id=request.org_id,
        plan=request.plan,
        capabilities=capabilities,
        user_email=request.user_email,
    )
    plan_provider, plan_model = resolve_provider_model(request.plan, request.user_email, json_mode=True)
    _log_masked_call(
        org_id=request.org_id,
        department=DEFAULT_DEPARTMENT,
        provider=plan_provider,
        model=plan_model,
        pii_result=pii_result,
        result=result,
    )
    return PlanResponse(
        capability_name=result.get("capability_name"),
        args=result.get("args", {}),
        confidence=result.get("confidence", 0.0),
        reasoning=result.get("reasoning", ""),
        inferred_name=result.get("inferred_name"),
        pii_detected=pii_result.detected,
        pii_types=_pii_types(pii_result),
    )


_RANK_SYSTEM_PROMPT = (
    "あなたは中小企業の社長補佐です。"
    "以下の成果物リストを、ビジネス上の重要度で high / mid / low に分類してください。\n"
    "- high: 売上・顧客・契約・重要な意思決定に直結（提案書、見積、重要顧客向けメール、経営判断材料など）\n"
    "- mid: 通常業務の資料・分析・社内向け\n"
    "- low: 参考・下書き・定型の軽微なもの\n"
    '必ず JSON のみを返す: {"rankings":[{"id":"<元のid>","importance":"high|mid|low","reason":"20字程度の理由"}]}。'
    "すべての id を必ず含めること。"
)

_VALID_IMPORTANCE = frozenset({"high", "mid", "low"})


def _parse_rankings(content: str) -> dict[str, Ranking]:
    """LLM の出力から id → Ranking を取り出す。壊れていれば例外（呼び出し側で全件 mid に倒す）。"""
    raw = content.strip()
    # ⚠️ planner._safe_parse_json とは順序が違う（こちらはフェンスを先に剥がす）。挙動を変えないため共通化しない
    if "```" in raw:
        body = raw.split("```", 2)[1]
        raw = body[4:] if body.startswith("json") else body
    parsed = json.loads(raw.strip())
    by_id: dict[str, Ranking] = {}
    for r in parsed.get("rankings", []):
        if not isinstance(r, dict):
            continue
        rid = r.get("id")
        imp = r.get("importance")
        if rid and imp in _VALID_IMPORTANCE:
            by_id[str(rid)] = Ranking(id=str(rid), importance=imp, reason=str(r.get("reason", ""))[:60])
    return by_id


@app.post("/rank", response_model=RankResponse)
async def rank(request: RankRequest) -> RankResponse:
    """成果物リストをビジネス上の重要度 (high/mid/low) で分類する。"""
    bind_org(request.org_id)
    if not request.items:
        return RankResponse(rankings=[])

    lines = [
        f'- id={it.id} | 部署={it.department or "?"} | {it.title}: {(it.summary or "")[:200]}'
        for it in request.items
    ]
    messages = [
        ChatMessage(role="system", content=_RANK_SYSTEM_PROMPT),
        ChatMessage(role="user", content="成果物:\n" + "\n".join(lines)),
    ]
    by_id: dict[str, Ranking] = {}
    try:
        response, _pii, _types = await llm_router.chat(
            messages=messages, department="GENERAL", org_id=request.org_id, plan=request.plan, json_mode=True
        )
        by_id = _parse_rankings(response.content)
    except Exception as e:
        # 失敗時は全件 mid にフォールバック
        logger.warning("[rank] 重要度の判定に失敗したため全件 mid で返します: %s", type(e).__name__)

    # 欠けた id は mid で補完（全件返す）
    rankings = [by_id.get(it.id, Ranking(id=it.id, importance="mid", reason="")) for it in request.items]
    return RankResponse(rankings=rankings)


@app.post("/vision/receipt", response_model=ReadReceiptResponse)
async def read_receipt_endpoint(request: ReadReceiptRequest) -> ReadReceiptResponse:
    bind_org(request.org_id)
    """領収書の写真から工事原価の候補を読み取る（記帳はしない）。

    返すのは候補だけ。工事・取引先の紐付けと確定は gateway 側で人が承認する。
    """
    if request.media_type not in ALLOWED_RECEIPT_MEDIA_TYPES:
        return ReadReceiptResponse(notes="対応していない画像形式です。写真で撮り直してください。")

    # base64 の長さから元のバイト数を見積もる（デコードせずに弾く）
    approx_bytes = (len(request.image_base64) * 3) // 4
    if approx_bytes > MAX_RECEIPT_IMAGE_BYTES:
        return ReadReceiptResponse(notes="画像が大きすぎます。もう少し小さいサイズで送ってください。")

    try:
        result = await read_receipt(request.image_base64, request.media_type)
    except Exception as e:  # noqa: BLE001 — 読めなかったことを人に返す（例外で 500 にしない）
        # ⚠️ 例外の中身をそのまま出さない。このフレームは request.image_base64 を握っており、
        #    例外の型は無制限なので、将来どこかで画像が文字列化される余地を残さない
        logger.warning("[vision/receipt] 読み取りに失敗: %s", type(e).__name__)
        return ReadReceiptResponse(notes="領収書を読み取れませんでした。手入力で登録してください。")

    # ⚠️ AILog には画像も base64 も残さない。入力は「領収書画像」という事実だけ。
    schedule_llm_log(
        org_id=request.org_id,
        department="ACCOUNTING",
        provider="anthropic",
        model=EXTRACT_MODEL,
        input_text="[領収書画像]",
        output_text=json.dumps(result, ensure_ascii=False),
        tokens=None,
        latency_ms=None,
        pii_detected=False,
        pii_types=[],
    )
    return ReadReceiptResponse(**result)


@app.post("/plan/http-node", response_model=PlanHttpNodeResponse)
async def plan_http_node_endpoint(request: PlanHttpNodeRequest) -> PlanHttpNodeResponse:
    bind_org(request.org_id)
    """curl / API ドキュメントの断片からカスタムノードの設定を提案する（保存はしない）。

    ⚠️ source には API キーが混ざりうるが、gateway の secret-scrubber と
    pii_screener の二重でマスクされてからここに届く。念のため screen() も通す。
    """
    pii_result = screen(request.source)
    result = await plan_http_node(
        source=pii_result.text,
        org_id=request.org_id,
        plan=request.plan,
    )
    _log_masked_call(
        org_id=request.org_id,
        department=DEFAULT_DEPARTMENT,
        provider="anthropic",
        model=AGENT_BUILD_MODEL,
        pii_result=pii_result,
        result=result,
    )
    return PlanHttpNodeResponse(**result)


@app.post("/plan/agent", response_model=PlanAgentResponse)
async def plan_agent_endpoint(request: PlanAgentRequest) -> PlanAgentResponse:
    bind_org(request.org_id)
    """自由記述から再利用可能なエージェント定義を推論する (opt-in)。

    screen_first=True のときは、先に安いモデルで「そもそも定型業務か」を判定し、
    通らなければ設計せずに confidence 0 で返す。
    ⚠️ 受動的な提案（会話から勝手に拾う経路）は、大半が定型業務ではない。
       判定を挟まないと、捨てる前提の設計を毎回 Opus で回すことになる。
    """
    pii_result = screen(request.description)

    if request.screen_first:
        verdict = await screen_agent(pii_result.text, request.org_id, request.plan)
        if not verdict["repeatable"] or verdict["confidence"] < 0.6:
            return PlanAgentResponse(
                confidence=0.0,
                reasoning=verdict.get("reason") or "繰り返し使える業務とは判断しませんでした",
            )

    capabilities = [c.model_dump() for c in request.available_capabilities]
    result = await plan_agent(
        description=pii_result.text,
        org_id=request.org_id,
        plan=request.plan,
        capabilities=capabilities,
        current_agent=request.current_agent.model_dump() if request.current_agent else None,
    )
    _log_masked_call(
        org_id=request.org_id,
        department=result.get("department", DEFAULT_DEPARTMENT),
        provider="anthropic",
        model=AGENT_BUILD_MODEL,  # エージェント構築は全ユーザー Opus 固定（松竹梅の例外）
        pii_result=pii_result,
        result=result,
    )
    return PlanAgentResponse(
        name=result.get("name"),
        department=result.get("department", DEFAULT_DEPARTMENT),
        instructions=result.get("instructions"),
        steps=[AgentStep(**s) for s in result.get("steps", [])],
        trigger=result.get("trigger", "MANUAL"),
        confidence=result.get("confidence", 0.0),
        reasoning=result.get("reasoning", ""),
    )
