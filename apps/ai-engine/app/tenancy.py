"""どの組織として動いているか（テナント）を、リクエストごとに持つ。

docs/design/multi-tenancy.md §7.2

■ 伝え方
  gateway は全呼び出しに ``X-Org-Id`` ヘッダを付け、body の ``org_id`` にも同じ値を入れる。
  middleware がヘッダを ``current_org_header`` に置き、各エンドポイントの先頭で ``bind_org(body.org_id)`` を呼ぶ。

■ 照合（環境変数 ORG_HEADER_MODE = off | warn | enforce。既定 warn）
  * ヘッダと body が食い違う → 403 ORG_MISMATCH（off 以外。正規の gateway は食い違いを作らないので warn でも拒否）
  * ヘッダが無い           → enforce なら 403、warn なら警告ログを出して通す（n8n 経由などの洗い出し用）
  * off                    → 何も照合しない（緊急時の切り戻し用）
  本番は warn で出し、ログに「ヘッダ無し」が出なくなったら enforce に切り替える。

■ 使う場面
  body と ContextVar の両方を持つのは、既存の関数（org_id=request.org_id を下へ渡す多くの呼び出し）の
  シグネチャを変えずに済ませるため。AILog を書く直前に ``org_matches_context`` で防御的に照合する。
"""

from __future__ import annotations

import logging
from contextvars import ContextVar

from fastapi import HTTPException

from app.config import settings

logger = logging.getLogger(__name__)

ORG_HEADER = "x-org-id"
ORG_HEADER_MODES = ("off", "warn", "enforce")

#: リクエストのヘッダ X-Org-Id（無ければ None）。middleware が置く
current_org_header: ContextVar[str | None] = ContextVar("current_org_header", default=None)
#: bind_org で確定した組織（コンテキストの外では None）
current_org: ContextVar[str | None] = ContextVar("current_org", default=None)


def org_header_mode() -> str:
    """ORG_HEADER_MODE。不正な値は warn に倒す（enforce に倒すと全停止、off に倒すと照合が消えるため）。"""
    mode = settings.org_header_mode
    return mode if mode in ORG_HEADER_MODES else "warn"


def _mismatch() -> HTTPException:
    # ⚠️ 理由を細かく返さない（どちらが何だったかを外に出さない）
    return HTTPException(status_code=403, detail={"code": "ORG_MISMATCH", "message": "organization mismatch"})


def bind_org(body_org_id: str) -> str:
    """ヘッダと body の org を照合し、確定した org をコンテキストに置いて返す。"""
    mode = org_header_mode()
    header = current_org_header.get()
    if mode != "off":
        if header and header != body_org_id:
            logger.warning("[tenancy] X-Org-Id と body の org_id が食い違うため拒否しました")
            raise _mismatch()
        if not header:
            if mode == "enforce":
                logger.warning("[tenancy] X-Org-Id が無いため拒否しました（ORG_HEADER_MODE=enforce）")
                raise _mismatch()
            logger.warning("[tenancy] X-Org-Id がありません（ORG_HEADER_MODE=warn。呼び出し元を確認）")
    current_org.set(body_org_id)
    return body_org_id


def org_matches_context(org_id: str) -> bool:
    """防御のアサーション。コンテキストの org が決まっていて、それと違う org で書こうとしたら False。"""
    bound = current_org.get()
    return bound is None or bound == org_id
