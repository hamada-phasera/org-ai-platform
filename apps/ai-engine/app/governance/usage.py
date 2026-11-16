"""月間の AI 呼び出し量を見て、上限を超えた組織を軽いモデルに落とす。

⚠️ 止めない。現場で「今日から使えません」は業務が止まり、そのまま解約になる。
   超えたら品質を落として使い続けさせ、記録は AILog に残す。

⚠️ 判定はここ1か所。LLMRouter が必ず通るので、ゲートウェイ経由も n8n 経由も同じ扱いになる。

⚠️ 読めないときは通す（fail-open）。利用量を数えられないことを理由に業務を止めない。
   ローカル開発の SQLite は date_trunc を持たないので、そこでも黙って通る。
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

# packages/shared-types の PLAN_LIMITS.aiCallsPerMonth と同じ値。
# tests/fixtures/plan-models.json を正本に、両側から検証している。
PLAN_CALL_LIMITS: dict[str, int] = {"STARTER": 3000, "PRO": 8000, "MAX": 20000}

# この割合を超えたら画面で警告する（止めはしない）。
WARN_RATIO = 0.8

_CACHE_TTL_SEC = 60
_cache: dict[str, tuple[float, int]] = {}


def limit_for_plan(plan: str) -> int:
    return PLAN_CALL_LIMITS.get(plan, PLAN_CALL_LIMITS["STARTER"])


def state_of(used: int, limit: int) -> str:
    """'ok' | 'warn' | 'over'。画面の表示とサーバの判定で同じ関数を使う。"""
    if limit <= 0:
        return "ok"
    if used >= limit:
        return "over"
    if used >= limit * WARN_RATIO:
        return "warn"
    return "ok"


async def monthly_calls(org_id: str) -> int | None:
    """当月（UTC）の AI 呼び出し回数。読めなければ None。"""
    if not org_id:
        return None
    now = time.time()
    hit = _cache.get(org_id)
    if hit and now - hit[0] < _CACHE_TTL_SEC:
        return hit[1]
    try:
        # ⚠️ import はここで行う。モジュールの先頭で読むと、LLMRouter を読むだけで
        #    SQLAlchemy と DB 設定が要るようになり、ルーティングのテストが動かなくなる
        from sqlalchemy import text  # noqa: PLC0415

        from app.db import AsyncSessionLocal  # noqa: PLC0415

        async with AsyncSessionLocal() as db:
            row = await db.execute(
                text(
                    'SELECT count(*) FROM "AILog" WHERE "orgId" = :org '
                    "AND \"createdAt\" >= date_trunc('month', (now() at time zone 'utc'))"
                ),
                {"org": org_id},
            )
            n = int(row.scalar() or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("[usage] 利用量を読めませんでした（上限の判定は行いません）: %s", e)
        return None
    _cache[org_id] = (now, n)
    return n


async def is_over_limit(org_id: str, plan: str) -> bool:
    used = await monthly_calls(org_id)
    if used is None:
        return False
    return state_of(used, limit_for_plan(plan)) == "over"


def note_call(org_id: str) -> None:
    """呼び出しを1回ぶん数える。

    ⚠️ これが無いと、キャッシュが生きている60秒のあいだ上限を跨げず、
       上限ちょうどの組織が何回でも高いモデルを使えてしまう。
    """
    hit = _cache.get(org_id)
    if hit:
        _cache[org_id] = (hit[0], hit[1] + 1)


def reset_cache() -> None:
    """テスト用。"""
    _cache.clear()
