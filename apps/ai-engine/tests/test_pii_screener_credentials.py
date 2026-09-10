"""資格情報マスクの契約テスト（gateway の secret-scrubber と共有のフィクスチャ）。

二段構えの防御は、二段目が一段目と同じ盲点を持っていたら二重防御にならない。
gateway 側にだけ規則を足すと、このテストが落ちて気づけるようにしてある。

pii_screener は app.governance の __init__ 経由だと重い依存を引くので、
ファイルを単独で読み込む。
"""

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "credential-samples.json"
MODULE_PATH = Path(__file__).resolve().parents[1] / "app" / "governance" / "pii_screener.py"


def _load_screener():
    spec = importlib.util.spec_from_file_location("pii_screener_standalone", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


screener = _load_screener()
fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))


def build(case: dict) -> tuple[str, list[str]]:
    """断片を結合して本文と「消えるべき値」を組み立てる。

    ⚠️ フィクスチャにベタ書きしないのは、本物そっくりの形が必要な一方で、
    そのまま書くと GitHub の secret scanning が本物と判定して push が止まるため。
    """
    values = {k: a["join"].join(a["parts"]) for k, a in case["assemble"].items()}
    text = case["textTemplate"]
    for k, v in values.items():
        text = text.replace("{{" + k + "}}", v)
    return text, [values[k] for k in case["mustVanish"]]


@pytest.mark.parametrize(
    "case", fixture["mustMask"], ids=[c["name"] for c in fixture["mustMask"]]
)
def test_must_mask(case: dict) -> None:
    text, secrets = build(case)
    masked, kinds = screener.scrub_credentials(text)
    for secret in secrets:
        assert secret not in masked, f"{case['name']}: 平文が残っている"
    assert kinds, f"{case['name']}: 何も検出していない"


@pytest.mark.parametrize(
    "case", fixture["mustNotMask"], ids=[c["name"] for c in fixture["mustNotMask"]]
)
def test_must_not_mask(case: dict) -> None:
    text, _ = screener.scrub_credentials(case["text"])
    assert text == case["text"], f"{case['name']}: 誤検出で本文を壊している"


def test_idempotent() -> None:
    """2回かけても壊れない（[REDACTED_*] を再度マスクしない）。"""
    for case in fixture["mustMask"]:
        text, _ = build(case)
        once, _ = screener.scrub_credentials(text)
        twice, _ = screener.scrub_credentials(once)
        assert twice == once


def test_credential_runs_before_phone_rule() -> None:
    """CREDENTIAL 判定は電話番号規則より先に走ること。

    JP_PHONE_RE が先に走ると、トークン中の数字列を電話番号として切り出してしまい、
    資格情報の正規表現がマッチしなくなる（＝マスクが外れる）。
    """
    key = "-".join(["sk", "ant", "api03", "0801234567890abcdefghij"])
    result = screener.screen(f"curl -H 'Authorization: Bearer {key}' https://x.test")
    assert key not in result.text
