"""HTTP API のリクエスト/レスポンス型（app.main のエンドポイントで使う）。

⚠️ フィールド名・既定値は gateway との契約。変えると gateway 側の呼び出しが壊れる。
   tests/test_main_api.py でレスポンスの形を固定している。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class PlanCapability(BaseModel):
    name: str
    displayName: str | None = None
    description: str
    department: str | None = None
    inputSchema: dict[str, Any]


class PlanRequest(BaseModel):
    message: str
    org_id: str
    plan: str = "STARTER"
    available_capabilities: list[PlanCapability]
    user_email: str | None = None  # 松竹梅ルーティング（admin判定）用


class PlanResponse(BaseModel):
    capability_name: str | None
    args: dict[str, Any]
    confidence: float
    reasoning: str
    inferred_name: str | None = None
    pii_detected: bool = False
    pii_types: list[str] = []


class CurrentAgent(BaseModel):
    """既存エージェントを修正するときに渡す現状。これがあると planner は
    「土台にして、依頼された変更だけを加えた steps 全体」を返す（差分ではなく完成形）。"""

    name: str | None = None
    instructions: str | None = None
    steps: list[dict[str, Any]] = []


class PlanAgentRequest(BaseModel):
    description: str
    org_id: str
    plan: str = "STARTER"
    available_capabilities: list[PlanCapability] = []
    current_agent: CurrentAgent | None = None
    # 受動的な提案（会話から勝手に拾う経路）だけ True。
    # 明示的に依頼された設計（/agents/suggest・チャットでの修正）では判定を挟まない。
    screen_first: bool = False


class AgentStep(BaseModel):
    capabilityName: str
    argTemplate: dict[str, Any] = {}


class PlanAgentResponse(BaseModel):
    name: str | None = None
    department: str = "GENERAL"
    instructions: str | None = None
    steps: list[AgentStep] = []
    trigger: str = "MANUAL"
    confidence: float = 0.0
    reasoning: str = ""


class RankItem(BaseModel):
    id: str
    title: str
    summary: str = ""
    department: str | None = None


class RankRequest(BaseModel):
    items: list[RankItem]
    org_id: str = ""
    plan: str = "STARTER"


class Ranking(BaseModel):
    id: str
    importance: str = "mid"  # high | mid | low
    reason: str = ""


class RankResponse(BaseModel):
    rankings: list[Ranking]


class PlanHttpNodeRequest(BaseModel):
    """貼られた curl / API ドキュメントからカスタムノード設定を起こす。"""

    source: str
    org_id: str
    plan: str = "STARTER"


class PlanHttpNodeResponse(BaseModel):
    name: str | None = None
    displayName: str | None = None
    description: str | None = None
    department: str = "GENERAL"
    params: list[dict[str, Any]] = []
    http: dict[str, Any] | None = None
    confidence: float = 0.5
    reasoning: str = ""


ALLOWED_RECEIPT_MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
"""Anthropic の画像入力が受け付ける形式。それ以外は送らずに落とす。"""

MAX_RECEIPT_IMAGE_BYTES = 5 * 1024 * 1024


class ReadReceiptRequest(BaseModel):
    """領収書画像の読み取り。

    ⚠️ 画像はここで一度使うだけで、**どこにも保存しない**。
    保管すると電子帳簿保存法の保管要件を背負うことになるため、v1 では抽出結果だけを持つ。
    """

    image_base64: str
    media_type: str = "image/jpeg"
    org_id: str
    # ⚠️ 受け取るが**ルーティングには使わない**。領収書の読み取りは全プラン Claude 固定。
    #    松竹梅の Gemini 側に画像入力の口が無いことに加え、金額の読み違いは
    #    トークン代より高くつくため（エージェント構築を全ユーザー Opus 固定にしているのと同じ判断）。
    #    互換のために残しているだけで、外すと gateway 側の呼び出しが壊れる。
    plan: str = "STARTER"


class ReadReceiptResponse(BaseModel):
    amountIncludingTax: int | None = None
    taxAmount: int | None = None
    incurredOn: str | None = None
    vendorHint: str | None = None
    category: str | None = None
    projectHint: str | None = None
    description: str | None = None
    confidence: float = 0.0
    notes: str | None = None
