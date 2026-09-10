"""領収書の写真から工事原価の候補を読み取る。

現場監督が LINE で領収書を撮って送るだけで済むようにするための入口。
中小建設業の現場アプリが3週目に使われなくなる最大の理由は入力項目の多さなので、
**入力項目ゼロ**にすることそのものが機能になる。

⚠️ 方針:
  * 読み取った値は候補であって確定値ではない。工事も取引先も断定させない。
  * 画像は保存しない（保管すると電子帳簿保存法の保管要件を背負う）。ここで使って捨てる。
  * 読めなかった項目は null を返させる。今日の日付や 0 円で埋めない
    （埋めると人が「読めている」と誤解して、そのまま承認してしまう）。
"""

from __future__ import annotations

import json
from typing import Any, Optional

from app.llm.providers.anthropic_provider import AnthropicProvider, MODEL_SONNET

SYSTEM = """あなたは建設業の経理を手伝うアシスタントです。
領収書・レシート・請求書の写真から、工事原価として記帳するための情報を読み取ります。

出力する JSON:
{
  "amountIncludingTax": 税込の合計金額（整数・円）。読めなければ null,
  "taxAmount": 消費税額（整数・円）。書かれていなければ null,
  "incurredOn": "YYYY-MM-DD"。読めなければ null,
  "vendorHint": 発行者・店名（原文のまま）。読めなければ null,
  "category": "MATERIAL" | "LABOR" | "SUBCON" | "OTHER" のいずれか。判断できなければ null,
  "projectHint": 工事名・現場名らしき記載があればその文字列。無ければ null,
  "description": 品目の要約（30字以内）。読めなければ null,
  "confidence": 0.0〜1.0,
  "notes": 人に確認してほしいことがあれば日本語で。無ければ null
}

守ること:
- **読めない項目は必ず null にする。推測で埋めない。**特に金額と日付を埋めてしまうと、
  人が「正しく読めている」と誤解してそのまま承認する。
- category は建設業会計の4分類。材料・資材の購入=MATERIAL、人工代・常用=LABOR、
  下請や一人親方への支払=SUBCON、それ以外（駐車場代・工具のレンタル・事務用品等）=OTHER。
  ホームセンターやガソリンスタンドのレシートは中身で判断し、迷ったら null にして notes に書く。
- 金額は**税込の合計**を取る。小計や単価ではない。
- 手書きの領収書で判読しづらい場合は confidence を下げ、notes に「手書きのため要確認」と書く。
- 領収書に見えない画像（現場写真・図面・スクリーンショット等）なら、
  すべて null・confidence 0 にして notes に何が写っているかを一言で書く。"""

PROMPT = "この画像から、上の JSON を1つだけ出力してください。"


def _as_int(value: Any) -> Optional[int]:
    """金額を整数に寄せる。文字列・小数・カンマ入りでも壊れないようにする。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(round(value))
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("円", "").replace("¥", "").strip()
        try:
            return int(round(float(cleaned)))
        except ValueError:
            return None
    return None


VALID_CATEGORIES = {"MATERIAL", "LABOR", "SUBCON", "OTHER"}


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """モデルの出力を、そのまま DB に入れられる形に整える。

    ⚠️ 無効な値は null に落とす。落とさずに通すと、確定時に型エラーで弾かれるか、
    もっと悪いと 0 円の明細が台帳に載る。
    """
    category = raw.get("category")
    if category not in VALID_CATEGORIES:
        category = None

    amount = _as_int(raw.get("amountIncludingTax"))
    if amount is not None and amount <= 0:
        amount = None

    tax = _as_int(raw.get("taxAmount"))
    if tax is not None and (tax < 0 or (amount is not None and tax > amount)):
        tax = None

    incurred = raw.get("incurredOn")
    if not isinstance(incurred, str) or len(incurred) != 10 or incurred[4] != "-":
        incurred = None

    confidence = raw.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = 0.0
    confidence = max(0.0, min(1.0, float(confidence)))

    def _text(key: str, limit: int) -> Optional[str]:
        v = raw.get(key)
        if not isinstance(v, str):
            return None
        v = v.strip()
        return v[:limit] if v else None

    return {
        "amountIncludingTax": amount,
        "taxAmount": tax,
        "incurredOn": incurred,
        "vendorHint": _text("vendorHint", 200),
        "category": category,
        "projectHint": _text("projectHint", 200),
        "description": _text("description", 200),
        "confidence": confidence,
        "notes": _text("notes", 500),
    }


async def read_receipt(image_base64: str, media_type: str) -> dict[str, Any]:
    """領収書画像から候補を読み取る。読めなければ全項目 null で返す（例外にしない）。"""
    provider = AnthropicProvider()
    response = await provider.vision_json(
        system=SYSTEM,
        prompt=PROMPT,
        image_base64=image_base64,
        media_type=media_type,
        model=MODEL_SONNET,
    )
    text = (response.content or "").strip()
    # コードブロックで包んで返してくることがある
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text
        if text.startswith("json"):
            text = text[4:]
    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return {
            **normalize({}),
            "notes": "領収書を読み取れませんでした。手入力で登録してください。",
        }
    if not isinstance(raw, dict):
        return {**normalize({}), "notes": "領収書を読み取れませんでした。"}
    return normalize(raw)
