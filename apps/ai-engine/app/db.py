from __future__ import annotations
import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

_db_url = os.getenv("DATABASE_URL", "file:./data/app.db")
_connect_args: dict = {}

if _db_url.startswith("file:"):
    # SQLite (ローカル開発用)
    _path = _db_url[len("file:"):]
    if not _path.startswith("/"):
        _base = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
        _path = os.path.join(_base, _path.lstrip("./"))
    _db_url = f"sqlite+aiosqlite:///{_path}"
elif _db_url.startswith("postgres://") or _db_url.startswith("postgresql://"):
    # PostgreSQL (本番用: Neon等)
    if _db_url.startswith("postgres://"):
        _db_url = "postgresql+asyncpg://" + _db_url[len("postgres://"):]
    else:
        _db_url = "postgresql+asyncpg://" + _db_url[len("postgresql://"):]

    # asyncpg は libpq 形式の sslmode / channel_binding クエリを受け付けず
    # `connect() got an unexpected keyword argument 'sslmode'` で全接続が失敗する
    # （本番 AILog が 0 件のままだった監査ログ全損バグの根因・2026-07-08 特定）。
    # → クエリから除去し、TLS 要求は connect_args の ssl=True へ変換する。
    _parts = urlsplit(_db_url)
    _query = dict(parse_qsl(_parts.query))
    _sslmode = _query.pop("sslmode", None)
    _query.pop("channel_binding", None)
    _db_url = urlunsplit(_parts._replace(query=urlencode(_query)))
    if _sslmode in ("require", "verify-ca", "verify-full", "prefer"):
        # Neon 等の sslmode=require を asyncpg の ssl=True へ変換。
        # sslmode 無指定（ローカル docker 等）は従来通り平文のまま。
        _connect_args["ssl"] = True

engine = create_async_engine(_db_url, echo=False, connect_args=_connect_args)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
