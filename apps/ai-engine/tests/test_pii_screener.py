"""PII スクリーナ（メール・電話・カード・マイナンバー・資格情報）。

資格情報の網羅的なケースは test_pii_screener_credentials.py（gateway と共有のフィクスチャ）。
"""

from __future__ import annotations

import pytest

from app.governance.pii_screener import PIIResult, _luhn_check, screen, scrub_credentials


def test_clean_text_passes_through() -> None:
    assert screen("今日の売上をまとめて") == PIIResult(text="今日の売上をまとめて", detected=False, types=[])


@pytest.mark.parametrize(
    ("text", "masked", "types"),
    [
        ("連絡先 taro.yamada+x@example.co.jp まで", "連絡先 [PII_EMAIL] まで", ["EMAIL"]),
        ("電話 03-1234-5678", "電話 [PII_PHONE]", ["PHONE"]),
        ("携帯 090 1234 5678", "携帯 [PII_PHONE]", ["PHONE"]),
        ("+81-90-1234-5678", "[PII_PHONE]", ["PHONE"]),
    ],
)
def test_contact_info(text: str, masked: str, types: list[str]) -> None:
    result = screen(text)
    assert result.detected is True
    assert result.types == types
    assert result.text == masked


def test_credit_card_requires_luhn() -> None:
    valid = screen("card 4242 4242 4242 4242")
    assert "CREDIT_CARD" in valid.types
    assert "4242" not in valid.text
    invalid = screen("番号 1234 5678 9012 3456 7")
    assert "CREDIT_CARD" not in invalid.types


def test_my_number() -> None:
    result = screen("マイナンバーは 1234-5678-9012 です")
    assert "MY_NUMBER" in result.types
    assert "1234-5678-9012" not in result.text


def test_credential_flag() -> None:
    key = "-".join(["sk", "ant", "api03", "abcdefghijklmnop"])
    result = screen(f"key={key}")
    assert "CREDENTIAL" in result.types
    assert key not in result.text
    assert result.types[-1] == "CREDENTIAL"  # 種別は最後に1回だけ付く


def test_types_order_and_combined() -> None:
    result = screen("a@example.com / 03-1234-5678")
    assert result.types == ["EMAIL", "PHONE"]
    assert result.text == "[PII_EMAIL] / [PII_PHONE]"


def test_masked_text_is_stable_on_second_pass() -> None:
    once = screen("a@example.com 03-1234-5678").text
    assert screen(once).text == once
    assert screen(once).detected is False


@pytest.mark.parametrize(("number", "ok"), [("4242424242424242", True), ("4242424242424241", False), ("0", True)])
def test_luhn(number: str, ok: bool) -> None:
    assert _luhn_check(number) is ok


class TestScrubCredentialsFalsePositives:
    @pytest.mark.parametrize(
        "text",
        [
            "Bearer authentication を使う",
            "Basic authentication の説明",
            "password: null",
            "token = undefined",
            "api_key=https://example.com/path",
            "普通の日本語の文章です。",
        ],
    )
    def test_not_masked(self, text: str) -> None:
        assert scrub_credentials(text) == (text, [])

    def test_bearer_keeps_prefix(self) -> None:
        out, kinds = scrub_credentials("Authorization: Bearer abc123def456")
        assert out == "Authorization: Bearer [REDACTED_BEARER]"
        assert kinds == ["BEARER"]

    def test_url_userinfo(self) -> None:
        out, kinds = scrub_credentials("https://user:hunter2pass@db.example.com/x")
        assert out == "https://user:[REDACTED_URL_PASSWORD]@db.example.com/x"
        assert "URL_USERINFO" in kinds

    def test_curl_user_arg(self) -> None:
        out, _ = scrub_credentials("curl -u admin:s3cr3tpass https://x")
        assert out == "curl -u admin:[REDACTED_BASIC_AUTH] https://x"

    def test_basic_auth_header(self) -> None:
        out, kinds = scrub_credentials("Authorization: Basic dXNlcjpwYXNz")
        assert out == "Authorization: Basic [REDACTED_BASIC_AUTH]"
        assert kinds == ["BASIC_AUTH"]

    def test_hex_and_base64_tokens(self) -> None:
        hex_token = "a" * 20 + "0123456789abcdef0123"
        assert scrub_credentials(f"id {hex_token}")[0] == "id [REDACTED_HEX_TOKEN]"
        b64 = "Ab1" * 14
        assert scrub_credentials(f"t {b64}")[0] == "t [REDACTED_BASE64_TOKEN]"
        # 3 クラスを含まない長い base64 風は素通し
        assert scrub_credentials("t " + "a" * 45)[1] != ["BASE64_TOKEN"]
