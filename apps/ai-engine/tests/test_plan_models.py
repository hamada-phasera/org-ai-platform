"""プランとタスクごとのモデル選択が、共有の表と一致していることを確かめる。

画面に出す表示名（packages/shared-types の PLAN_LIMITS）と、実際にAPIを叩く
決定点（router.py）が食い違うと、顧客が受け取っていないモデル名を表示することになる。
実際にそうなっていたので、両側から同じ JSON を検証する形にしてある。
"""

import json
import os
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "plan-models.json"

fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))


def _stub_anthropic_sdk() -> None:
    """anthropic SDK をスタブする。

    ⚠️ スタブするのは**SDKだけ**。provider モジュールは本物を読み込ませて、
    MODEL_HAIKU / MODEL_SONNET / MODEL_OPUS の実際の値を検証する。
    provider ごとスタブすると、この表が本物と一致しているかを確かめられなくなる。
    """
    if "anthropic" in sys.modules:
        return

    mod = types.ModuleType("anthropic")

    class _Err(Exception):
        pass

    mod.AsyncAnthropic = lambda **_kw: None  # type: ignore[attr-defined]
    for name in (
        "APIStatusError", "APIConnectionError", "APITimeoutError",
        "InternalServerError", "RateLimitError",
    ):
        setattr(mod, name, type(name, (_Err,), {}))
    sys.modules["anthropic"] = mod


def _load_router():
    _stub_anthropic_sdk()
    # 有料/無料の分岐に入る前に、Gemini キーがある状態を作る
    # （未設定だと全プラン Anthropic にフォールバックする安全機構が働くため）
    os.environ.setdefault("GEMINI_API_KEY", "test-key-for-routing-assertions")
    os.environ.pop("ADMIN_EMAILS", None)

    # router は app.* を絶対 import するので、リポジトリのルートを import path に入れる
    app_root = str(Path(__file__).resolve().parents[1])
    if app_root not in sys.path:
        sys.path.insert(0, app_root)

    import app.llm.router as router_module  # noqa: PLC0415

    return router_module


router = _load_router()


@pytest.mark.parametrize("plan", ["STARTER", "PRO", "MAX"])
def test_chat_model_matches_fixture(plan: str) -> None:
    """本文生成のモデルが、画面に出す表と一致する。"""
    expected = fixture["plans"][plan]
    provider, model = router.resolve_provider_model(plan, user_email=None, json_mode=False)
    assert provider == expected["provider"], f"{plan}: provider が表と違う"
    assert model == expected["model"], f"{plan}: model が表と違う"


@pytest.mark.parametrize("kind_name", ["SCREEN", "DESIGN", "EXTRACT"])
def test_task_model_is_plan_independent(kind_name: str) -> None:
    """判定・設計・抽出は、どのプランでも同じモデルになる。"""
    expected = fixture["tasks"][kind_name]
    kind = getattr(router.TaskKind, kind_name)
    for plan in ("STARTER", "PRO", "MAX"):
        provider, model = router.resolve_for_task(kind, plan)
        assert provider == expected["provider"], f"{kind_name}/{plan}: provider が表と違う"
        assert model == expected["model"], f"{kind_name}/{plan}: model が表と違う"


def test_chat_task_still_follows_plan() -> None:
    """CHAT だけはプランに従う（共通化しない）。"""
    starter = router.resolve_for_task(router.TaskKind.CHAT, "STARTER")
    mx = router.resolve_for_task(router.TaskKind.CHAT, "MAX")
    assert starter != mx, "CHAT がプランで変わらなくなっている"
    assert starter[1] == fixture["plans"]["STARTER"]["model"]
    assert mx[1] == fixture["plans"]["MAX"]["model"]


def test_screen_is_cheaper_than_design() -> None:
    """判定が設計と同じモデルになっていないこと。

    ⚠️ これが同じになると、捨てる前提の判定を最上位モデルで回すことになる。
       実際にそうなっており、チャット1往復の原価の大半を占めていた。
    """
    _, screen_model = router.resolve_for_task(router.TaskKind.SCREEN, "MAX")
    _, design_model = router.resolve_for_task(router.TaskKind.DESIGN, "MAX")
    assert screen_model != design_model


def test_gemini_key_missing_falls_back_to_anthropic() -> None:
    """Gemini のキーが無い環境では、全プラン Anthropic に落ちる（起動を壊さない）。"""
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        provider, _model = router.resolve_provider_model("STARTER")
        assert provider == "anthropic"
    finally:
        if saved is not None:
            os.environ["GEMINI_API_KEY"] = saved
