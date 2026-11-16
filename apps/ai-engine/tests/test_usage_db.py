"""usage.monthly_calls の DB 読み取り・キャッシュ・fail-open（DB はフェイク）。"""

from __future__ import annotations

from typing import Any

import pytest

import app.db
from app.governance import usage


class _Result:
    def __init__(self, n: Any) -> None:
        self.n = n

    def scalar(self) -> Any:
        return self.n


class _Session:
    def __init__(self, n: Any = 5, fail: bool = False) -> None:
        self.n, self.fail, self.calls = n, fail, 0

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, _stmt: Any, params: dict[str, Any]) -> _Result:
        self.calls += 1
        if self.fail:
            raise RuntimeError("no date_trunc on sqlite")
        assert params == {"org": "org-1"}
        return _Result(self.n)


@pytest.fixture(autouse=True)
def _clean() -> Any:
    usage.reset_cache()
    yield
    usage.reset_cache()


async def test_empty_org_is_none() -> None:
    assert await usage.monthly_calls("") is None


async def test_reads_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _Session(n=42)
    monkeypatch.setattr(app.db, "AsyncSessionLocal", lambda: s)
    assert await usage.monthly_calls("org-1") == 42
    assert await usage.monthly_calls("org-1") == 42
    assert s.calls == 1


async def test_cache_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _Session(n=1)
    monkeypatch.setattr(app.db, "AsyncSessionLocal", lambda: s)
    await usage.monthly_calls("org-1")
    t0 = usage._cache["org-1"][0]
    monkeypatch.setattr(usage.time, "time", lambda: t0 + usage._CACHE_TTL_SEC + 1)
    await usage.monthly_calls("org-1")
    assert s.calls == 2


async def test_null_count_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.db, "AsyncSessionLocal", lambda: _Session(n=None))
    assert await usage.monthly_calls("org-1") == 0


async def test_db_error_is_fail_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.db, "AsyncSessionLocal", lambda: _Session(fail=True))
    assert await usage.monthly_calls("org-1") is None
    assert "org-1" not in usage._cache
    assert await usage.is_over_limit("org-1", "STARTER") is False
