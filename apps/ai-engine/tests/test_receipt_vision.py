"""領収書読み取りの正規化。読めない値は推測で埋めず null に落とす。"""

from __future__ import annotations

import json
from typing import Any

import pytest

import app.llm.router as router
from app.llm.router import EXTRACT_MODEL
from app.planner import receipt_vision as rv
from tests.conftest import Providers


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        (True, None),
        (1100, 1100),
        (1100.6, 1101),
        ("1,100円", 1100),
        ("¥2,000", 2000),
        ("abc", None),
        ([1], None),
    ],
)
def test_as_int(value: Any, expected: int | None) -> None:
    assert rv._as_int(value) == expected


class TestNormalize:
    def test_empty(self) -> None:
        assert rv.normalize({}) == {
            "amountIncludingTax": None,
            "taxAmount": None,
            "incurredOn": None,
            "vendorHint": None,
            "category": None,
            "projectHint": None,
            "description": None,
            "confidence": 0.0,
            "notes": None,
        }

    def test_valid(self) -> None:
        out = rv.normalize(
            {
                "amountIncludingTax": "11,000",
                "taxAmount": 1000,
                "incurredOn": "2026-11-01",
                "vendorHint": "  ホームセンター  ",
                "category": "MATERIAL",
                "projectHint": "山田邸",
                "description": "木材",
                "confidence": 0.9,
                "notes": "",
            }
        )
        assert out["amountIncludingTax"] == 11000
        assert out["taxAmount"] == 1000
        assert out["incurredOn"] == "2026-11-01"
        assert out["vendorHint"] == "ホームセンター"
        assert out["category"] == "MATERIAL"
        assert out["notes"] is None

    @pytest.mark.parametrize("amount", [0, -5])
    def test_non_positive_amount(self, amount: int) -> None:
        assert rv.normalize({"amountIncludingTax": amount})["amountIncludingTax"] is None

    @pytest.mark.parametrize(("tax", "expected"), [(-1, None), (1000, None), (1200, None), (99, 99)])
    def test_tax_must_be_below_amount(self, tax: int, expected: int | None) -> None:
        assert rv.normalize({"amountIncludingTax": 1000, "taxAmount": tax})["taxAmount"] == expected

    @pytest.mark.parametrize("date", ["2026-13-45", "abcd-ef-gh", "2026/11/01", 20261101])
    def test_invalid_dates(self, date: Any) -> None:
        assert rv.normalize({"incurredOn": date})["incurredOn"] is None

    @pytest.mark.parametrize(("conf", "expected"), [(True, 0.0), ("0.9", 0.0), (2, 1.0), (-1, 0.0), (0.42, 0.42)])
    def test_confidence(self, conf: Any, expected: float) -> None:
        assert rv.normalize({"confidence": conf})["confidence"] == expected

    def test_invalid_category(self) -> None:
        assert rv.normalize({"category": "FOOD"})["category"] is None

    def test_text_limits(self) -> None:
        out = rv.normalize({"vendorHint": "a" * 300, "notes": "n" * 600, "description": 5})
        assert len(out["vendorHint"]) == 200
        assert len(out["notes"]) == 500
        assert out["description"] is None


class TestReadReceipt:
    async def test_reads_with_extract_model(self, providers: Providers) -> None:
        providers.anthropic.reply = "```json\n" + json.dumps({"amountIncludingTax": 500, "confidence": 0.5}) + "\n```"
        out = await rv.read_receipt("AAAA", "image/png")
        assert out["amountIncludingTax"] == 500
        call = providers.anthropic.calls[0]
        assert call["kind"] == "vision"
        assert call["model"] == EXTRACT_MODEL == "claude-sonnet-4-6"
        assert call["system"] == rv.SYSTEM
        assert call["image_base64"] == "AAAA"

    @pytest.mark.parametrize("reply", ["読めません", "[1]", ""])
    async def test_unreadable(self, providers: Providers, reply: str) -> None:
        providers.anthropic.reply = reply
        out = await rv.read_receipt("AAAA", "image/png")
        assert out["notes"] == "領収書を読み取れませんでした。手入力で登録してください。"
        assert out["amountIncludingTax"] is None

    async def test_uses_router_singleton(self, providers: Providers) -> None:
        # ⚠️ 毎回 new しない（コネクションプールが積み上がる）
        assert router._get_anthropic() is providers.anthropic
