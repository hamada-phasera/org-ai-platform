"""月間の呼び出し上限を超えたときの扱いを固定する。

⚠️ 超えても止めない。軽いモデルに落として使い続けさせる。
   「今日から使えません」は現場の業務を止め、そのまま解約になる。
"""

import asyncio
import json
import os
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((REPO_ROOT / "tests" / "fixtures" / "plan-models.json").read_text(encoding="utf-8"))

APP_ROOT = str(Path(__file__).resolve().parents[1])
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from app.governance import usage  # noqa: E402


@pytest.fixture(autouse=True)
def _clean():
    usage.reset_cache()
    yield
    usage.reset_cache()


class TestContract:
    """共有の表（tests/fixtures/plan-models.json）と一致していること。"""

    @pytest.mark.parametrize("plan", ["STARTER", "PRO", "MAX"])
    def test_limits_match_fixture(self, plan):
        assert usage.PLAN_CALL_LIMITS[plan] == FIXTURE["plans"][plan]["callsPerMonth"]

    def test_warn_ratio_matches_fixture(self):
        assert usage.WARN_RATIO == FIXTURE["usage"]["warnRatio"]

    def test_over_behavior_is_degrade(self):
        # 止める実装に変えるなら、この表と現場への影響を先に見直すこと
        assert FIXTURE["usage"]["overBehavior"] == "degrade"


class TestState:
    def test_boundaries(self):
        assert usage.state_of(0, 3000) == "ok"
        assert usage.state_of(2399, 3000) == "ok"
        assert usage.state_of(2400, 3000) == "warn"   # ちょうど 80%
        assert usage.state_of(2999, 3000) == "warn"
        assert usage.state_of(3000, 3000) == "over"   # ちょうど上限で over
        assert usage.state_of(9999, 3000) == "over"

    def test_unknown_plan_falls_back_to_cheapest(self):
        assert usage.limit_for_plan("UNKNOWN") == usage.PLAN_CALL_LIMITS["STARTER"]

    def test_zero_limit_never_blocks(self):
        assert usage.state_of(10, 0) == "ok"


class TestOverLimit:
    def test_fail_open_when_db_unreadable(self, monkeypatch):
        async def _none(_org):
            return None

        monkeypatch.setattr(usage, "monthly_calls", _none)
        # ⚠️ 利用量を数えられないことを理由に業務を止めない
        assert asyncio.run(usage.is_over_limit("org-1", "STARTER")) is False

    def test_over_when_counted_above_limit(self, monkeypatch):
        async def _many(_org):
            return 3000

        monkeypatch.setattr(usage, "monthly_calls", _many)
        assert asyncio.run(usage.is_over_limit("org-1", "STARTER")) is True
        # 上位プランなら同じ回数でもまだ上限内
        assert asyncio.run(usage.is_over_limit("org-1", "PRO")) is False

    def test_note_call_advances_cached_count(self):
        usage._cache["org-1"] = (usage.time.time(), 2999)
        usage.note_call("org-1")
        assert usage._cache["org-1"][1] == 3000
        # キャッシュが生きている間も上限を跨げること
        assert asyncio.run(usage.is_over_limit("org-1", "STARTER")) is True

    def test_note_call_is_noop_without_cache(self):
        usage.note_call("never-counted")
        assert "never-counted" not in usage._cache


def _stub_anthropic_sdk() -> None:
    if "anthropic" in sys.modules:
        return
    mod = types.ModuleType("anthropic")

    class _Err(Exception):
        pass

    mod.AsyncAnthropic = lambda **_kw: None  # type: ignore[attr-defined]
    for name in ("APIStatusError", "APIConnectionError", "APITimeoutError", "InternalServerError", "RateLimitError"):
        setattr(mod, name, type(name, (_Err,), {}))
    sys.modules["anthropic"] = mod


class TestRouterDegrade:
    """上限超過で実際にモデルが落ちること。落とすのは本文生成だけ。"""

    def _router(self):
        _stub_anthropic_sdk()
        os.environ.setdefault("GEMINI_API_KEY", "test-key-for-routing-assertions")
        os.environ.pop("ADMIN_EMAILS", None)
        import app.llm.router as router_module  # noqa: PLC0415

        return router_module

    def test_content_model_degrades_to_cheapest(self, monkeypatch):
        r = self._router()

        async def _over(_org, _plan):
            return True

        monkeypatch.setattr(r, "is_over_limit", _over)
        provider, model = asyncio.run(r._degrade_if_over_limit("org-1", "MAX", "anthropic", r.MODEL_OPUS))
        assert (provider, model) == ("gemini", r.GEMINI_UME)

    def test_no_change_when_within_limit(self, monkeypatch):
        r = self._router()

        async def _ok(_org, _plan):
            return False

        monkeypatch.setattr(r, "is_over_limit", _ok)
        provider, model = asyncio.run(r._degrade_if_over_limit("org-1", "MAX", "anthropic", r.MODEL_OPUS))
        assert (provider, model) == ("anthropic", r.MODEL_OPUS)

    def test_already_cheapest_stays(self, monkeypatch):
        r = self._router()

        async def _over(_org, _plan):
            return True

        monkeypatch.setattr(r, "is_over_limit", _over)
        provider, model = asyncio.run(r._degrade_if_over_limit("org-1", "STARTER", "gemini", r.GEMINI_UME))
        assert (provider, model) == ("gemini", r.GEMINI_UME)
