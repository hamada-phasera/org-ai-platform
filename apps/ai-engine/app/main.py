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
from app.planner import plan_capability


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

    # エージェントのシステムプロンプトを取得
    from app.orchestrator.orchestrator import _agents
    agent = _agents.get(resolved_dept, _agents["GENERAL"])
    messages = [ChatMessage(role="system", content=agent.system_prompt)]
    messages.append(ChatMessage(role="user", content=request.message))

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
    response, _pii, _types = await llm_router.chat(
        messages=request.messages,
        department=request.department,
        org_id=request.org_id,
        plan=request.plan,
        json_mode=request.json_mode,
    )
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
