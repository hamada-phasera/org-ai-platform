from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import text

from app.db import AsyncSessionLocal

logger = logging.getLogger(__name__)


def _calc_risk_score(pii_detected: bool, pii_types: list[str], tokens: int | None) -> float:
    """
    シンプルなルールベースのリスクスコア計算 (0.0〜1.0)
    - PII なし → 0.0
    - PII 種別数・種類でスコアを加算
    - クレジットカード・マイナンバーは高リスク
    """
    if not pii_detected:
        return 0.0
    score = 0.1 * len(pii_types)
    if "CREDIT_CARD" in pii_types:
        score += 0.5
    if "MY_NUMBER" in pii_types:
        score += 0.4
    if "PHONE" in pii_types:
        score += 0.1
    if "EMAIL" in pii_types:
        score += 0.1
    return min(score, 1.0)


async def log_llm_call(
    *,
    org_id: str,
    department: str,
    provider: str,
    model: str,
    input_text: str,
    output_text: str | None,
    tokens: int | None,
    latency_ms: int | None,
    pii_detected: bool,
    pii_types: list[str],
) -> str | None:
    """AI呼び出しを AILog テーブルに記録し、PII 検出時は RiskEvent も挿入する。"""
    risk_score = _calc_risk_score(pii_detected, pii_types, tokens)
    log_id = str(uuid.uuid4())

    try:
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("""
                INSERT INTO "AILog" (id, "orgId", department, provider, model,
                    "inputText", "outputText", tokens, "latencyMs", "riskScore", "createdAt")
                VALUES (:id, :org_id, :department, :provider, :model,
                    :input_text, :output_text, :tokens, :latency_ms, :risk_score, NOW())
                """),
                {
                    "id": log_id,
                    "org_id": org_id,
                    "department": department,
                    "provider": provider,
                    "model": model,
                    "input_text": input_text[:4000],   # 長すぎる入力を切り詰め
                    "output_text": (output_text or "")[:4000],
                    "tokens": tokens,
                    "latency_ms": latency_ms,
                    "risk_score": risk_score,
                },
            )

            if pii_detected:
                severity = "HIGH" if risk_score >= 0.5 else "MEDIUM"
                await db.execute(
                    text("""
                    INSERT INTO "RiskEvent" (id, "orgId", "aiLogId", type, description, severity, resolved, "createdAt")
                    VALUES (:id, :org_id, :ai_log_id, 'PII_DETECTED', :description, :severity, false, NOW())
                    """),
                    {
                        "id": str(uuid.uuid4()),
                        "org_id": org_id,
                        "ai_log_id": log_id,
                        "description": f"PII detected and masked: {', '.join(pii_types)}",
                        "severity": severity,
                    },
                )

            await db.commit()
    except Exception as e:
        logger.warning("audit_logger failed (non-fatal): %s", e)
        return None

    return log_id


# create_task の戻り値を誰も握っていないと、実行中のタスクが GC で回収されうる
# （asyncio のドキュメントに明記）。完了まで参照を持っておく。
_background_tasks: set[asyncio.Task[Any]] = set()


def schedule_llm_log(**kwargs: Any) -> asyncio.Task[str | None]:
    """log_llm_call をレスポンスを待たせずにバックグラウンドで実行する。

    引数は log_llm_call と同じ。失敗しても呼び出し元には波及しない（log_llm_call 内で握りつぶす）。
    """
    task = asyncio.create_task(log_llm_call(**kwargs))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task
