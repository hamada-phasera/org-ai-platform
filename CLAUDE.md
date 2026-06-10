# CLAUDE.md — FLOW - みんなのAIオフィス プロジェクト指示書

## プロジェクト概要

中小企業向けの「組織型AIエージェント基盤SaaS」を開発する。
社長（ユーザー）が指示を出し、各部署AI（営業部・SNSマーケ部・経理部等）が分担・実行・報告する構造。
AIガバナンス機能（ログ監視・リスク検知）を補助機能として内蔵する。

## 技術スタック (ローカル開発版)

| レイヤー | 技術 | 役割 |
|---|---|---|
| フロントエンド | React 18 + Vite + TypeScript | SPA、社長UI |
| APIゲートウェイ | Node.js (Fastify) + TypeScript | 認証、ルーティング、WebSocket |
| AI処理エンジン | Python 3.11+ (FastAPI) | エージェント実行、Intent分類、リスク検知、LLM呼び出し |
| データベース | PostgreSQL (Prisma) | 本番=Neon / ローカル=docker-compose |
| LLM | Anthropic Claude | プラン別 (STARTER=Haiku / PRO=Sonnet / MAX=Opus)。LLMRouter経由 |
| ワークフロー | n8n (セルフホスト) | 部署/capability/エージェントの実行基盤。Webhook起動＋AI Engineフォールバック |
| 認証 | JWT自前実装 (bcryptjs + @fastify/jwt) | シンプル認証 |
| ファイル保存 | ローカルファイルシステム | ./data/files/ |
| インフラ | docker-compose | ローカル開発環境 |

## リポジトリ構成

```
org-ai-platform/
├── CLAUDE.md
├── apps/
│   ├── web/                   # React SPA (port 3000)
│   ├── api-gateway/           # Fastify (port 4000)
│   └── ai-engine/             # FastAPI (port 8000)
├── packages/
│   ├── shared-types/          # 共有TypeScript型定義
│   └── db-schema/             # DBマイグレーション (Prisma + SQLite)
├── docker-compose.yml
├── .env.example
└── tasks/                     # エージェントチーム用タスク定義
```

## 開発ルール

- TypeScriptは strict モードを使用する
- Python は型ヒントを必ず付ける
- すべてのAPIエンドポイントにJWT認証を適用する (認証系を除く)
- LLM呼び出しは必ずLLMRouter経由にする（直接呼び出し禁止）
- すべてのAI入出力をAILogテーブルに記録する
- PII検知を通過してからLLMに送信する
- エラーハンドリングは統一フォーマットで返す: `{ success: false, error: { code, message } }`
- 環境変数は .env ファイルで管理する

## 環境変数

```
ANTHROPIC_API_KEY=    # Anthropic APIキー (必須、ai-engine の LLM 呼び出し)
JWT_SECRET=           # JWT署名シークレット (必須、32文字以上推奨)
DATABASE_URL=postgresql://...   # Neon(本番) / docker-compose(ローカル)
FRONTEND_URL=http://localhost:3000   # 本番はカンマ区切りで Vercel ドメインを含める (CORS)
API_GATEWAY_URL=http://localhost:4000
AI_ENGINE_URL=http://localhost:8000
# n8n (任意。未設定なら AI Engine フォールバックで動作)
N8N_CLOUD_URL=        # or N8N_URL。エージェント実行・ワークフロー生成の宛先
N8N_API_KEY=          # n8n Public API キー。エージェント専用ワークフローの動的生成にも使用
N8N_WEBHOOK_AUTH_TOKEN=org-ai-n8n-secret-token   # Webhook Header Auth
```

## エージェント機能 (業務効率化エージェント)

- ユーザーはチャット/フォームから再利用可能なエージェントを作成 (`POST /api/agents`)。
- 作成時に n8n Public API で専用ワークフロー `agent-<id>` を **best-effort 生成** (`n8n-workflow-builder.ts`)。
  n8n が落ちていても作成は成功し `n8nStatus=PENDING`、実行時は AI Engine `/llm/chat` にフォールバック。
- 一覧 (`GET /api/agents`) から選択して再実行 (`POST /api/agents/:id/run`) → `Task` を作成し
  `dispatchAgentTask` が n8n webhook（コールドスタート時はリトライ＋「n8n起動中…」ログ）→ フォールバックで実行。
- フロント: `/agents` ページ (一覧/作成/実行)、`CreateAgentModal` / `AgentRunModal`。
- DB が真実の源。n8n は自動化の加速レイヤーであって依存先ではない。

## n8n 稼働とコールドスタート

Render 無料枠は ~15分でスリープ・全サービス合計 750h/月の制約があり 3 サービスの 24h 常時稼働は不可。
- 緩和: `.github/workflows/keepalive.yml` が平日 JST 9-19 のみ health を叩く（月 ~220h で枠内）。
- 実行は常に AI Engine フォールバックで完了するため n8n スリープ中でも動く。
- 安定性が必要なら有料化: Render Standard ($7/月/サービス, スリープ無し) または n8n Cloud（常時稼働・Postgres 90日削除問題も解消）。

## タスク実行順序

Phase 1 (並列): tasks/00-setup.md + tasks/01-database.md
Phase 2 (並列): tasks/02-auth.md + tasks/03-llm-router.md
Phase 3 (依存): tasks/04-agent-framework.md
Phase 4 (並列): tasks/05-governance.md + tasks/06-frontend.md + tasks/07-file-access.md
Phase 5 (最終): tasks/08-integration.md
