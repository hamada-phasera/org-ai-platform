import os
import asyncio
import json
import time
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Optional
from app.models.llm import OrchestateRequest, OrchestrateResponse, LLMRequest, LLMResponse, ChatMessage
from app.orchestrator.orchestrator import orchestrator
from app.orchestrator.intent_classifier import classify_intent
from app.llm.router import llm_router, _resolve_model
from app.governance.audit_logger import log_llm_call
from app.governance.pii_screener import screen
from app.planner import plan_capability, plan_agent


class PlanCapability(BaseModel):
    name: str
    displayName: Optional[str] = None
    description: str
    department: Optional[str] = None
    inputSchema: dict[str, Any]


class PlanRequest(BaseModel):
    message: str
    org_id: str
    plan: str = "STARTER"
    available_capabilities: list[PlanCapability]


class PlanResponse(BaseModel):
    capability_name: Optional[str]
    args: dict[str, Any]
    confidence: float
    reasoning: str
    inferred_name: Optional[str] = None
    pii_detected: bool = False
    pii_types: list[str] = []


class PlanAgentRequest(BaseModel):
    description: str
    org_id: str
    plan: str = "STARTER"
    available_capabilities: list[PlanCapability] = []


class AgentStep(BaseModel):
    capabilityName: str
    argTemplate: dict[str, Any] = {}


class PlanAgentResponse(BaseModel):
    name: Optional[str] = None
    department: str = "GENERAL"
    instructions: Optional[str] = None
    steps: list[AgentStep] = []
    trigger: str = "MANUAL"
    confidence: float = 0.0
    reasoning: str = ""

app = FastAPI(title="AI Engine", version="1.0.0")

allowed_origins = os.getenv("API_GATEWAY_URL", "http://localhost:4000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-engine",
        "version": "1.0.0",
        "timestamp": __import__("datetime").datetime.utcnow().isoformat(),
    }


@app.get("/ready")
async def ready() -> dict:
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    return {
        "status": "ok" if has_key else "degraded",
        "anthropic": has_key,
        "timestamp": __import__("datetime").datetime.utcnow().isoformat(),
    }


@app.post("/orchestrate", response_model=OrchestrateResponse)
async def orchestrate(request: OrchestateRequest) -> OrchestrateResponse:
    try:
        return await orchestrator.process(
            user_message=request.message,
            org_id=request.org_id,
            plan=request.plan,
            department=request.department,
            context=request.context,
            history=request.history,
        )
    except RuntimeError as e:
        msg = str(e)
        if "ANTHROPIC_API_KEY" in msg:
            raise HTTPException(status_code=503, detail=msg) from e
        raise


@app.post("/orchestrate/stream")
async def orchestrate_stream(request: OrchestateRequest) -> StreamingResponse:
    """SSE ストリーミングエンドポイント。トークンを1つずつ返す。"""
    # 部署を解決
    if request.department and request.department in (
        "SALES",
        "MARKETING",
        "ACCOUNTING",
        "ANALYTICS",
        "GENERAL",
    ):
        resolved_dept = request.department
    else:
        resolved_dept = await classify_intent(request.message)

    # エージェントのシステムプロンプトを取得（セキュリティ核 + エージェント化提案を含む統一ビルダ経由）
    from app.orchestrator.orchestrator import _agents
    from app.agents.base import _build_system_prompt, _wrap_user_message, _sanitize_history, GROUNDING_INSTRUCTION
    agent = _agents.get(resolved_dept, _agents["GENERAL"])
    system_content = _build_system_prompt(agent.system_prompt, getattr(agent, "security_extra", ""))
    has_context = bool(request.context and request.context.strip())
    if has_context:
        system_content = system_content + "\n\n" + GROUNDING_INSTRUCTION
    messages = [ChatMessage(role="system", content=system_content)]
    if has_context:
        messages.append(ChatMessage(role="system", content=f"【参考資料】\n{request.context.strip()}"))
    # 直近の会話履歴（ヒアリングが前回の回答を踏まえて進行できるように）
    if request.history:
        messages.extend(_sanitize_history(request.history))
    messages.append(ChatMessage(role="user", content=_wrap_user_message(request.message)))

    # PII スクリーニング
    pii_detected = False
    pii_types: list[str] = []
    for i, msg in enumerate(messages):
        if msg.role == "user":
            result = screen(msg.content)
            if result.detected:
                pii_detected = True
                pii_types.extend(result.types)
                messages[i] = ChatMessage(role=msg.role, content=result.text)

    async def event_generator():
        start = time.monotonic()
        full_content = ""
        # 最初に部署情報を送信
        yield f"data: {json.dumps({'type': 'department', 'department': resolved_dept})}\n\n"
        try:
            async for token in llm_router.chat_stream(
                messages=messages,
                department=resolved_dept,
                org_id=request.org_id,
                plan=request.plan,
            ):
                full_content += token
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

            latency_ms = int((time.monotonic() - start) * 1000)
            # 完了イベント
            yield f"data: {json.dumps({'type': 'done', 'department': resolved_dept})}\n\n"

            # 監査ログを非同期で記録
            asyncio.create_task(log_llm_call(
                org_id=request.org_id,
                department=resolved_dept,
                provider="anthropic",
                model=_resolve_model(request.plan),
                input_text=request.message,
                output_text=full_content,
                tokens=None,
                latency_ms=latency_ms,
                pii_detected=pii_detected,
                pii_types=pii_types,
            ))
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/llm/chat", response_model=LLMResponse)
async def llm_chat(request: LLMRequest) -> LLMResponse:
    response, pii_detected, pii_types = await llm_router.chat(
        messages=request.messages,
        department=request.department,
        org_id=request.org_id,
        plan=request.plan,
        json_mode=request.json_mode,
    )
    # 監査ログ: /llm/chat を直接叩く経路（ゲートウェイ /api/llm/chat・各部署の生成機能）も
    # 必ず AILog / RiskEvent に残す。CLAUDE.md「すべての AI 入出力を AILog に記録」・
    # integration-requests 営業#5（/plan・/orchestrate と同様に集中ロギング）。
    input_text = "\n".join(m.content for m in request.messages if m.role == "user")
    asyncio.create_task(log_llm_call(
        org_id=request.org_id,
        department=request.department,
        provider="anthropic",
        model=response.model,
        input_text=input_text,
        output_text=response.content,
        tokens=response.tokens_used,
        latency_ms=response.latency_ms,
        pii_detected=pii_detected,
        pii_types=pii_types,
    ))
    return response


@app.post("/plan", response_model=PlanResponse)
async def plan(request: PlanRequest) -> PlanResponse:
    pii_result = screen(request.message)
    capabilities = [c.model_dump() for c in request.available_capabilities]
    result = await plan_capability(
        message=pii_result.text,
        org_id=request.org_id,
        plan=request.plan,
        capabilities=capabilities,
    )
    asyncio.create_task(log_llm_call(
        org_id=request.org_id,
        department="GENERAL",
        provider="anthropic",
        model=_resolve_model(request.plan),
        input_text=request.message,
        output_text=json.dumps(result, ensure_ascii=False),
        tokens=None,
        latency_ms=None,
        pii_detected=pii_result.detected,
        pii_types=list(pii_result.types) if pii_result.detected else [],
    ))
    return PlanResponse(
        capability_name=result.get("capability_name"),
        args=result.get("args", {}),
        confidence=result.get("confidence", 0.0),
        reasoning=result.get("reasoning", ""),
        inferred_name=result.get("inferred_name"),
        pii_detected=pii_result.detected,
        pii_types=list(pii_result.types) if pii_result.detected else [],
    )


class RankItem(BaseModel):
    id: str
    title: str
    summary: str = ""
    department: Optional[str] = None


class RankRequest(BaseModel):
    items: list[RankItem]
    org_id: str = ""
    plan: str = "STARTER"


class Ranking(BaseModel):
    id: str
    importance: str = "mid"  # high | mid | low
    reason: str = ""


class RankResponse(BaseModel):
    rankings: list[Ranking]


@app.post("/rank", response_model=RankResponse)
async def rank(request: RankRequest) -> RankResponse:
    """成果物リストをビジネス上の重要度 (high/mid/low) で分類する。"""
    if not request.items:
        return RankResponse(rankings=[])

    lines = [
        f'- id={it.id} | 部署={it.department or "?"} | {it.title}: {(it.summary or "")[:200]}'
        for it in request.items
    ]
    system = (
        "あなたは中小企業の社長補佐です。以下の成果物リストを、ビジネス上の重要度で high / mid / low に分類してください。\n"
        "- high: 売上・顧客・契約・重要な意思決定に直結（提案書、見積、重要顧客向けメール、経営判断材料など）\n"
        "- mid: 通常業務の資料・分析・社内向け\n"
        "- low: 参考・下書き・定型の軽微なもの\n"
        '必ず JSON のみを返す: {"rankings":[{"id":"<元のid>","importance":"high|mid|low","reason":"20字程度の理由"}]}。'
        "すべての id を必ず含めること。"
    )
    messages = [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content="成果物:\n" + "\n".join(lines)),
    ]
    valid = {"high", "mid", "low"}
    by_id: dict[str, Ranking] = {}
    try:
        response, _pii, _types = await llm_router.chat(
            messages=messages, department="GENERAL", org_id=request.org_id, plan=request.plan, json_mode=True
        )
        raw = response.content.strip()
        if "```" in raw:
            body = raw.split("```", 2)[1]
            raw = body[4:] if body.startswith("json") else body
        parsed = json.loads(raw.strip())
        for r in parsed.get("rankings", []):
            if not isinstance(r, dict):
                continue
            rid = r.get("id")
            imp = r.get("importance")
            if rid and imp in valid:
                by_id[str(rid)] = Ranking(id=str(rid), importance=imp, reason=str(r.get("reason", ""))[:60])
    except Exception:
        pass  # 失敗時は全件 mid にフォールバック

    # 欠けた id は mid で補完（全件返す）
    rankings = [by_id.get(it.id, Ranking(id=it.id, importance="mid", reason="")) for it in request.items]
    return RankResponse(rankings=rankings)


@app.post("/plan/agent", response_model=PlanAgentResponse)
async def plan_agent_endpoint(request: PlanAgentRequest) -> PlanAgentResponse:
    """自由記述から再利用可能なエージェント定義を推論する (opt-in)。"""
    pii_result = screen(request.description)
    capabilities = [c.model_dump() for c in request.available_capabilities]
    result = await plan_agent(
        description=pii_result.text,
        org_id=request.org_id,
        plan=request.plan,
        capabilities=capabilities,
    )
    asyncio.create_task(log_llm_call(
        org_id=request.org_id,
        department=result.get("department", "GENERAL"),
        provider="anthropic",
        model=_resolve_model(request.plan),
        input_text=request.description,
        output_text=json.dumps(result, ensure_ascii=False),
        tokens=None,
        latency_ms=None,
        pii_detected=pii_result.detected,
        pii_types=list(pii_result.types) if pii_result.detected else [],
    ))
    return PlanAgentResponse(
        name=result.get("name"),
        department=result.get("department", "GENERAL"),
        instructions=result.get("instructions"),
        steps=[AgentStep(**s) for s in result.get("steps", [])],
        trigger=result.get("trigger", "MANUAL"),
        confidence=result.get("confidence", 0.0),
        reasoning=result.get("reasoning", ""),
    )
