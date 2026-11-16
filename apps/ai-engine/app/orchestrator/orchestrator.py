from __future__ import annotations

from app.agents.accounting import AccountingAgent
from app.agents.analytics import AnalyticsAgent
from app.agents.general import GeneralAgent
from app.agents.marketing import MarketingAgent
from app.agents.sales import SalesAgent
from app.governance.audit_logger import schedule_llm_log
from app.llm.router import provider_of_model
from app.models.llm import OrchestrateResponse
from app.orchestrator.intent_classifier import classify_intent

_agents = {
    "SALES": SalesAgent(),
    "MARKETING": MarketingAgent(),
    "ACCOUNTING": AccountingAgent(),
    "ANALYTICS": AnalyticsAgent(),
    "GENERAL": GeneralAgent(),
}


class Orchestrator:
    async def process(
        self,
        user_message: str,
        org_id: str,
        plan: str = "STARTER",
        department: str | None = None,
        context: str | None = None,
        history=None,
        user_email: str | None = None,
    ) -> OrchestrateResponse:
        if department and department in _agents:
            resolved_dept = department
        else:
            resolved_dept = await classify_intent(user_message)
        agent = _agents.get(resolved_dept, _agents["GENERAL"])

        response, pii_detected, pii_types = await agent.execute(
            user_message=user_message,
            org_id=org_id,
            plan=plan,
            context=context,
            history=history,
            user_email=user_email,
        )

        # 監査ログを非同期で記録（失敗してもレスポンスは返す）
        schedule_llm_log(
            org_id=org_id,
            department=resolved_dept,
            provider=provider_of_model(response.model),
            model=response.model,
            input_text=user_message,
            output_text=response.content,
            tokens=response.tokens_used,
            latency_ms=response.latency_ms,
            pii_detected=pii_detected,
            pii_types=pii_types,
        )

        return OrchestrateResponse(
            content=response.content,
            department=resolved_dept,
            model=response.model,
            tokens_used=response.tokens_used,
            latency_ms=response.latency_ms,
        )


orchestrator = Orchestrator()
