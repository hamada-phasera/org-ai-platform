
from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: str  # user | assistant | system
    content: str


class LLMRequest(BaseModel):
    messages: list[ChatMessage]
    department: str
    org_id: str
    plan: str = "STARTER"
    json_mode: bool = False
    # 松竹梅ルーティング用: ADMIN_EMAILS 照合に使う（無ければ plan のみで判定）
    user_email: str | None = None


class LLMResponse(BaseModel):
    content: str
    model: str
    tokens_used: int
    latency_ms: int
    pii_detected: bool


class OrchestateRequest(BaseModel):
    message: str
    org_id: str
    session_id: str = ""
    plan: str = "STARTER"
    department: str | None = None
    # RAG: アップロードファイル/過去チャットから取得した根拠ブロック（任意）
    context: str | None = None
    # 直近の会話履歴（ヒアリングが回答を積み上げて進行できるように）
    history: list[ChatMessage] = []
    # 松竹梅ルーティング用: ADMIN_EMAILS 照合に使う（無ければ plan のみで判定）
    user_email: str | None = None


class OrchestrateResponse(BaseModel):
    content: str
    department: str
    model: str
    tokens_used: int
    latency_ms: int
