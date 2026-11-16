"""プロバイダ実装（Anthropic / Gemini）で共有する定数。"""

from __future__ import annotations

from typing import Final

# 1回の応答で生成させる最大トークン数（両プロバイダ共通）
MAX_TOKENS: Final = 4096

# json_mode のとき system の末尾に足す指示（両プロバイダで同じ文言）
JSON_MODE_HINT: Final = (
    "\n\n出力は有効な JSON オブジェクト 1 つのみとし、前後に説明文・コードブロックを含めないこと。"
)

# リトライ対象の HTTP ステータス（一時的なもの）。400 等の恒久的エラーは即時失敗させる
RETRYABLE_STATUS_CODES: Final = frozenset({408, 409, 429, 500, 502, 503, 529})
