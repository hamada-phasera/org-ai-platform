"""無料枠のまま有料のお客さまを乗せていないかを知らせる。

⚠️ Gemini の無料枠は「入力が Google の製品改善に使われる」と明記されている。
   領収書や LINE のやり取りを扱う以上、有料プランの土台にはできない。
"""

import os
import sys
import types
from pathlib import Path

import pytest

APP_ROOT = str(Path(__file__).resolve().parents[1])
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)


def _load_router():
    if "anthropic" not in sys.modules:
        mod = types.ModuleType("anthropic")

        class _Err(Exception):
            pass

        mod.AsyncAnthropic = lambda **_kw: None  # type: ignore[attr-defined]
        for name in ("APIStatusError", "APIConnectionError", "APITimeoutError", "InternalServerError", "RateLimitError"):
            setattr(mod, name, type(name, (_Err,), {}))
        sys.modules["anthropic"] = mod
    import app.llm.router as router_module  # noqa: PLC0415

    return router_module


@pytest.fixture
def router(monkeypatch):
    r = _load_router()
    monkeypatch.setattr(r, "_warned_free_tier", False)
    return r


def test_warns_when_paid_tier_not_declared(router, monkeypatch, caplog):
    monkeypatch.delenv("GEMINI_PAID_TIER", raising=False)
    with caplog.at_level("WARNING"):
        router._warn_if_gemini_free_tier()
    assert "無料枠" in caplog.text


def test_warns_only_once(router, monkeypatch, caplog):
    monkeypatch.delenv("GEMINI_PAID_TIER", raising=False)
    with caplog.at_level("WARNING"):
        router._warn_if_gemini_free_tier()
        caplog.clear()
        router._warn_if_gemini_free_tier()
    # 毎回の呼び出しでログを埋めない（1リクエストごとに出ると本物の警告が埋もれる）
    assert caplog.text == ""


@pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes"])
def test_silent_when_paid_tier_declared(router, monkeypatch, caplog, value):
    monkeypatch.setenv("GEMINI_PAID_TIER", value)
    with caplog.at_level("WARNING"):
        router._warn_if_gemini_free_tier()
    assert caplog.text == ""


def test_warns_when_value_is_false(router, monkeypatch, caplog):
    monkeypatch.setenv("GEMINI_PAID_TIER", "false")
    with caplog.at_level("WARNING"):
        router._warn_if_gemini_free_tier()
    assert "無料枠" in caplog.text
