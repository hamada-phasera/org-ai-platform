from __future__ import annotations

from app.agents.accounting import AccountingAgent
from app.agents.analytics import AnalyticsAgent
from app.agents.base import BaseAgent
from app.agents.general import GeneralAgent
from app.agents.marketing import MarketingAgent
from app.agents.sales import SalesAgent
from app.departments import DEFAULT_DEPARTMENT
from app.governance.audit_logger import schedule_llm_log
from app.llm.router import provider_of_model
from app.models.llm import ChatMessage, OrchestrateResponse
from app.orchestrator.intent_classifier import classify_intent

_agents: dict[str, BaseAgent] = {
    "SALES": SalesAgent(),
    "MARKETING": MarketingAgent(),
    "ACCOUNTING": AccountingAgent(),
    "ANALYTICS": AnalyticsAgent(),
    "GENERAL": GeneralAgent(),
}


async def resolve_department(user_message: str, department: str | None) -> str:
    """明示された部署が有効ならそれを、無ければキーワードで分類した部署を返す。"""
    if department and department in _agents:
        return department
    return await classify_intent(user_message)


def get_agent(department: str) -> BaseAgent:
    """部署のエージェント。未知の部署は GENERAL。"""
    return _agents.get(department, _agents[DEFAULT_DEPARTMENT])


class Orchestrator:
    async def process(
        self,
        user_message: str,
        org_id: str,
        plan: str = "STARTER",
        department: str | None = None,
        context: str | None = None,
        history: list[ChatMessage] | None = None,
        user_email: str | None = None,
    ) -> OrchestrateResponse:
        resolved_dept = await resolve_department(user_message, department)
        agent = get_agent(resolved_dept)

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
