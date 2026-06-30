from __future__ import annotations
import json
import logging
from typing import Any
from app.models.llm import ChatMessage
from app.llm.router import llm_router
from app.planner.prompts import build_planner_system_prompt, build_planner_user_prompt

logger = logging.getLogger(__name__)


async def plan_capability(
    message: str,
    org_id: str,
    plan: str,
    capabilities: list[dict[str, Any]],
) -> dict[str, Any]:
    if not capabilities:
        return {
            "capability_name": None,
            "args": {},
            "confidence": 0.0,
            "reasoning": "登録済みケイパビリティが 0 件",
        }

    messages = [
        ChatMessage(role="system", content=build_planner_system_prompt(capabilities)),
        ChatMessage(role="user", content=build_planner_user_prompt(message)),
    ]
    try:
        response, _pii, _types = await llm_router.chat(
            messages=messages,
            department="GENERAL",
            org_id=org_id,
            plan=plan,
            json_mode=True,
        )
    except Exception as e:
        logger.exception("planner LLM call failed")
        return {
            "capability_name": None,
            "args": {},
            "confidence": 0.0,
            "reasoning": f"LLM 呼び出し失敗: {e}",
        }

    raw = response.content.strip()
    parsed = _safe_parse_json(raw)
    if parsed is None:
        return {
            "capability_name": None,
            "args": {},
            "confidence": 0.0,
            "reasoning": f"LLM 出力の JSON パース失敗: {raw[:120]}",
        }

    name = parsed.get("capability_name")
    if name is not None and not isinstance(name, str):
        name = None
    args = parsed.get("args") if isinstance(parsed.get("args"), dict) else {}
    confidence = parsed.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = 0.5
    reasoning = parsed.get("reasoning") if isinstance(parsed.get("reasoning"), str) else ""

    available_names = {c["name"] for c in capabilities}
    if name is not None and name not in available_names:
        return {
            "capability_name": None,
            "args": {},
            "confidence": 0.0,
            "reasoning": f"LLM が未登録の name='{name}' を返したため UNSUPPORTED 扱い",
            "inferred_name": name,
        }

    return {
        "capability_name": name,
        "args": args,
        "confidence": float(confidence),
        "reasoning": reasoning,
    }


def _safe_parse_json(raw: str) -> dict[str, Any] | None:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # フェンス付きで返した時の救済
    if "```" in raw:
        try:
            body = raw.split("```", 2)[1]
            if body.startswith("json"):
                body = body[4:]
            return json.loads(body.strip())
        except (json.JSONDecodeError, IndexError):
            return None
    return None
