"""DATABASE_URL（Prisma 形式）→ SQLAlchemy(async) URL の変換。

⚠️ sslmode をそのまま asyncpg に渡すと全接続が失敗し、AILog が全損する（2026-07-08 の障害）。
"""

from __future__ import annotations

import pytest

from app.db import build_engine_url


def test_sqlite_relative_path_is_resolved_from_base_dir() -> None:
    url, args = build_engine_url("file:./data/app.db", base_dir="/repo")
    assert url == "sqlite+aiosqlite:////repo/data/app.db"
    assert args == {}


def test_sqlite_absolute_path_is_kept() -> None:
    url, _ = build_engine_url("file:/var/db/app.db", base_dir="/repo")
    assert url == "sqlite+aiosqlite:////var/db/app.db"


@pytest.mark.parametrize("scheme", ["postgres://", "postgresql://"])
def test_postgres_scheme_becomes_asyncpg(scheme: str) -> None:
    url, args = build_engine_url(f"{scheme}u:p@host:5432/db")
    assert url == "postgresql+asyncpg://u:p@host:5432/db"
    assert args == {}


@pytest.mark.parametrize("mode", ["require", "verify-ca", "verify-full", "prefer"])
def test_sslmode_is_converted_to_ssl_true(mode: str) -> None:
    url, args = build_engine_url(f"postgresql://u:p@h/db?sslmode={mode}&channel_binding=require&x=1")
    assert "sslmode" not in url
    assert "channel_binding" not in url
    assert url.endswith("?x=1")
    assert args == {"ssl": True}


def test_sslmode_disable_stays_plaintext() -> None:
    url, args = build_engine_url("postgresql://u:p@h/db?sslmode=disable")
    assert url == "postgresql+asyncpg://u:p@h/db"
    assert args == {}


def test_unknown_scheme_passthrough() -> None:
    assert build_engine_url("mysql://x") == ("mysql://x", {})
