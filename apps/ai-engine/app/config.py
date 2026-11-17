"""ai-engine の環境変数を読む唯一の場所。

⚠️ 値は**アクセスのたびに os.environ から読む**（キャッシュしない）。
   - テストが monkeypatch.setenv / delenv で切り替えた値がそのまま効く
   - main.py の load_dotenv() より前に import されても、.env の値を取りこぼさない
   起動時に一度だけ固めたい値（CORS の許可オリジンなど）は、呼び出し側のモジュールで
   import 時に読んで定数にする（従来どおりのタイミング）。

既定値は分散していた os.getenv(...) の既定値と完全に一致させてある。変えるときは
挙動が変わることに注意（tests/test_config.py で固定している）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_API_GATEWAY_URL = "http://localhost:4000"
DEFAULT_DATABASE_URL = "file:./data/app.db"
DEFAULT_GEMINI_MODEL_UME = "gemini-2.5-flash-lite"
DEFAULT_GEMINI_MODEL_TAKE = "gemini-2.5-flash"

_TRUTHY = ("1", "true", "yes")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    """環境変数へのアクセサ。インスタンスは状態を持たない（毎回 os.environ を読む）。"""

    # ── LLM プロバイダ ─────────────────────────────────────────
    @property
    def anthropic_api_key(self) -> str:
        """未設定なら空文字。"""
        return _env("ANTHROPIC_API_KEY")

    @property
    def gemini_api_key(self) -> str:
        """未設定なら空文字（= 梅/竹も Anthropic にフォールバック）。"""
        return _env("GEMINI_API_KEY")

    @property
    def gemini_paid_tier(self) -> bool:
        """GEMINI_PAID_TIER が 1/true/yes（大文字小文字・前後空白は無視）。"""
        return _env("GEMINI_PAID_TIER").strip().lower() in _TRUTHY

    @property
    def gemini_model_ume(self) -> str:
        return _env("GEMINI_MODEL_UME", DEFAULT_GEMINI_MODEL_UME)

    @property
    def gemini_model_take(self) -> str:
        return _env("GEMINI_MODEL_TAKE", DEFAULT_GEMINI_MODEL_TAKE)

    @property
    def gemini_model_json(self) -> str:
        """構造化処理用。未設定なら梅のモデル（GEMINI_MODEL_UME を反映した値）。"""
        return _env("GEMINI_MODEL_JSON", self.gemini_model_ume)

    # ── 権限・認証 ────────────────────────────────────────────
    @property
    def admin_emails_raw(self) -> str:
        return _env("ADMIN_EMAILS")

    @property
    def admin_emails(self) -> set[str]:
        """カンマ区切りを小文字・前後空白除去で集合にする。空要素は捨てる。"""
        return {e.strip().lower() for e in self.admin_emails_raw.split(",") if e.strip()}

    @property
    def internal_api_token(self) -> str:
        """gateway との共有シークレット。前後空白は除去。未設定なら空文字（= 認証なし）。"""
        return _env("INTERNAL_API_TOKEN").strip()

    @property
    def org_header_mode(self) -> str:
        """X-Org-Id の照合モード: off | warn | enforce（小文字化・前後空白除去）。既定 warn。
        不正な値の扱いは app.tenancy.org_header_mode が決める。"""
        return _env("ORG_HEADER_MODE", "warn").strip().lower()

    @property
    def rls_mode(self) -> str:
        """RLS Phase 2a: 'on' | 'off'（小文字化・前後空白除去。on 以外はすべて off）。既定 off。
        on のとき AILog / RiskEvent を触る前に同じトランザクションで set_config('app.org_id', …, true) を呼ぶ
        （app.db.set_tenant）。packages/db-schema/rls/phase2a.sql を流して接続を flow_app に替えてから on にする。"""
        return "on" if _env("RLS_MODE", "off").strip().lower() == "on" else "off"

    # ── ネットワーク・DB ───────────────────────────────────────
    @property
    def allowed_origins(self) -> list[str]:
        """CORS の許可オリジン。API_GATEWAY_URL をカンマで分割（空白は除去しない＝従来どおり）。"""
        return _env("API_GATEWAY_URL", DEFAULT_API_GATEWAY_URL).split(",")

    @property
    def database_url(self) -> str:
        return _env("DATABASE_URL", DEFAULT_DATABASE_URL)

    @property
    def database_url_configured(self) -> bool:
        """DATABASE_URL が明示されているか（空白だけは未設定扱い）。起動時の警告に使う。"""
        return bool(_env("DATABASE_URL").strip())


settings = Settings()
