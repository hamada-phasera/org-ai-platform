"""app.config の既定値と遅延評価を固定する。

⚠️ 既定値は config.py に集約する前の os.getenv(...) と一致していなければならない。
   変わると本番の挙動（CORS・DB 接続先・Gemini のモデル）が黙って変わる。
"""

from __future__ import annotations

import pytest

from app.config import Settings, settings

ALL_VARS = (
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GEMINI_PAID_TIER",
    "GEMINI_MODEL_UME",
    "GEMINI_MODEL_TAKE",
    "GEMINI_MODEL_JSON",
    "ADMIN_EMAILS",
    "INTERNAL_API_TOKEN",
    "ORG_HEADER_MODE",
    "API_GATEWAY_URL",
    "DATABASE_URL",
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in ALL_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_defaults_match_previous_inline_defaults(clean_env: pytest.MonkeyPatch) -> None:
    s = Settings()
    assert s.anthropic_api_key == ""
    assert s.gemini_api_key == ""
    assert s.gemini_paid_tier is False
    assert s.gemini_model_ume == "gemini-2.5-flash-lite"
    assert s.gemini_model_take == "gemini-2.5-flash"
    assert s.gemini_model_json == "gemini-2.5-flash-lite"
    assert s.admin_emails_raw == ""
    assert s.admin_emails == set()
    assert s.internal_api_token == ""
    assert s.allowed_origins == ["http://localhost:4000"]
    assert s.database_url == "file:./data/app.db"


def test_database_url_configured(clean_env: pytest.MonkeyPatch) -> None:
    # 未設定なら起動時に警告する（既定の SQLite では利用量を数えられない）
    assert settings.database_url_configured is False
    clean_env.setenv("DATABASE_URL", "  ")
    assert settings.database_url_configured is False
    clean_env.setenv("DATABASE_URL", "postgresql://u@h/db")
    assert settings.database_url_configured is True


def test_values_are_read_lazily(clean_env: pytest.MonkeyPatch) -> None:
    """モジュールの import 後に setenv しても反映される（テストの monkeypatch を壊さない）。"""
    assert settings.gemini_api_key == ""
    clean_env.setenv("GEMINI_API_KEY", "k1")
    assert settings.gemini_api_key == "k1"
    clean_env.delenv("GEMINI_API_KEY")
    assert settings.gemini_api_key == ""


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1", True),
        ("true", True),
        ("TRUE", True),
        (" yes ", True),
        ("false", False),
        ("0", False),
        ("", False),
        ("on", False),  # 従来どおり 1/true/yes 以外は偽
    ],
)
def test_gemini_paid_tier(clean_env: pytest.MonkeyPatch, value: str, expected: bool) -> None:
    clean_env.setenv("GEMINI_PAID_TIER", value)
    assert settings.gemini_paid_tier is expected


def test_admin_emails_normalized(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("ADMIN_EMAILS", " Boss@Example.com, ,ops@example.com ,")
    assert settings.admin_emails == {"boss@example.com", "ops@example.com"}


def test_internal_token_is_stripped(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("INTERNAL_API_TOKEN", "  secret\n")
    assert settings.internal_api_token == "secret"


def test_allowed_origins_split_without_strip(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("API_GATEWAY_URL", "https://a.example,https://b.example")
    assert settings.allowed_origins == ["https://a.example", "https://b.example"]


def test_gemini_json_model_follows_ume_override(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("GEMINI_MODEL_UME", "gemini-custom")
    assert settings.gemini_model_json == "gemini-custom"
    clean_env.setenv("GEMINI_MODEL_JSON", "gemini-json")
    assert settings.gemini_model_json == "gemini-json"


def test_org_header_mode_default_and_normalized(clean_env: pytest.MonkeyPatch) -> None:
    from app.config import settings

    assert settings.org_header_mode == "warn"
    clean_env.setenv("ORG_HEADER_MODE", "  ENFORCE ")
    assert settings.org_header_mode == "enforce"
