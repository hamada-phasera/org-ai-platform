from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

# file: の相対パスはリポジトリのルート（apps/ai-engine/app から 3 つ上）を起点に解決する
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))

# asyncpg に TLS を要求させる sslmode の値
_SSL_REQUIRED_MODES = ("require", "verify-ca", "verify-full", "prefer")


def build_engine_url(raw_url: str, base_dir: str = _REPO_ROOT) -> tuple[str, dict[str, Any]]:
    """Prisma 形式の DATABASE_URL を SQLAlchemy(async) の URL と connect_args に変換する。

    - file:<path>             → sqlite+aiosqlite（相対パスは base_dir 起点）
    - postgres(ql)://...      → postgresql+asyncpg（sslmode / channel_binding を除去）
    - それ以外                → そのまま
    """
    url = raw_url
    connect_args: dict[str, Any] = {}

    if url.startswith("file:"):
        # SQLite (ローカル開発用)
        path = url[len("file:"):]
        if not path.startswith("/"):
            # ⚠️ lstrip は「先頭の . と / をすべて」削る（"./" の接頭辞削除ではない）。従来どおり
            path = os.path.join(base_dir, path.lstrip("./"))
        return f"sqlite+aiosqlite:///{path}", connect_args

    if url.startswith(("postgres://", "postgresql://")):
        # PostgreSQL (本番用: Supabase / Neon 等)
        scheme = "postgres://" if url.startswith("postgres://") else "postgresql://"
        url = "postgresql+asyncpg://" + url[len(scheme):]

        # asyncpg は libpq 形式の sslmode / channel_binding クエリを受け付けず
        # `connect() got an unexpected keyword argument 'sslmode'` で全接続が失敗する
        # （本番 AILog が 0 件のままだった監査ログ全損バグの根因・2026-07-08 特定）。
        # → クエリから除去し、TLS 要求は connect_args の ssl=True へ変換する。
        parts = urlsplit(url)
        query = dict(parse_qsl(parts.query))
        sslmode = query.pop("sslmode", None)
        query.pop("channel_binding", None)
        url = urlunsplit(parts._replace(query=urlencode(query)))
        if sslmode in _SSL_REQUIRED_MODES:
            # Neon 等の sslmode=require を asyncpg の ssl=True へ変換。
            # sslmode 無指定（ローカル docker 等）は従来通り平文のまま。
            connect_args["ssl"] = True

    return url, connect_args


_db_url, _connect_args = build_engine_url(settings.database_url)

engine = create_async_engine(_db_url, echo=False, connect_args=_connect_args)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session
