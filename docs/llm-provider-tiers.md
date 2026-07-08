# LLM プロバイダ松竹梅ルーティング設計 2026-07-08

> ユーザー決定: 梅竹=Gemini（無料運用）/ 松・admin=Claude / エージェント構築は全ユーザー Opus。
> 実装済み（ai-engine LLMRouter 一点分岐）。n8n も AI Engine `/llm/chat` 経由のため自動適用。

## ルーティング表（決定点 = `app/llm/router.py: resolve_provider_model`）

| 条件 | provider | 本文生成 | 構造化(json_mode) |
|------|----------|---------|------------------|
| admin（`ADMIN_EMAILS` 一致） | anthropic | plan準拠（Sonnet/Opus） | Haiku |
| 松 = plan `MAX` | anthropic | Opus | Haiku |
| 竹 = plan `PRO` | **gemini** | `GEMINI_MODEL_TAKE`（既定 gemini-2.5-flash） | `GEMINI_MODEL_JSON`（既定 flash-lite） |
| 梅 = plan `STARTER` | **gemini** | `GEMINI_MODEL_UME`（既定 gemini-2.5-flash-lite） | 同上 |
| **例外: エージェント構築 `/plan/agent`** | anthropic | — | **Opus 固定（全ユーザー・`AGENT_BUILD_MODEL`）** |
| `GEMINI_API_KEY` 未設定 | anthropic | plan準拠 | Haiku（安全フォールバック・警告ログ1回） |

## 経路と適用範囲
- 全 LLM 呼び出しは `llm_router` に収束（main.py `/llm/chat` `/orchestrate` `/orchestrate/stream` `/plan` `/rank`・planner・agents/base）→ **1点で全経路に適用**。
- **n8n**: gateway が組む `llmBody` を n8n が `/llm/chat` へそのまま転送する設計のため、**n8n 実行も自動的に松竹梅適用**（n8n 側の変更ゼロ）。llmBody は user_email を含まず plan のみで判定（サーバ起点のため）。admin の org を MAX にしておけば n8n 経由も Claude。
- **admin 判定の伝搬**: JWT に `email` クレームを追加（auth.ts）→ gateway の各 AI Engine 呼び出しが `user_email` を同送 → ai-engine が `ADMIN_EMAILS`（カンマ区切り・大文字小文字無視）と照合。**旧トークン（email 無し）は plan のみで判定**（安全側）。

## AILog / ガバナンス
- `AILog.provider/model` は実際に使ったプロバイダを記録（`provider_of_model()` で導出。gemini-* → "gemini"）。
- PII スクリーニングはプロバイダ非依存で従来通り router 内で適用。
- 分析（usage-metrics-svc）のコスト算出は Anthropic 単価表ベース → **Gemini 行はコスト0円扱いにする対応が今後必要**（pricing.go に gemini プレフィックス→0 を足すのが最小。フェーズ2）。

## 新環境変数（ai-engine）
- `GEMINI_API_KEY` — Google AI Studio 無料キー。**未設定でも起動・全プラン Claude フォールバック（課金注意）**
- `ADMIN_EMAILS` — admin の email（カンマ区切り）
- `GEMINI_MODEL_UME` / `GEMINI_MODEL_TAKE` / `GEMINI_MODEL_JSON` — モデル上書き（省略可）
- `/ready` が `gemini` / `admin_emails_configured` を返すのでデプロイ後の設定確認に使える。

## 運用ノート
- **Gemini 無料枠のレート制限（429）**: provider 内で指数バックオフ再試行（4回）。枠尽きは即 Claude に切替えない（無断課金防止）。恒常的に尽きるなら有料 Gemini か竹→梅モデル変更で対処。
- Gemini モデル名は将来世代交代するため env で無停止切替可能。
- ストリーミング（チャットUI）も Gemini SSE 対応済み。
