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
| データベース | SQLite (Prisma) | 開発用ローカルDB |
| LLM | Groq API (Llama3-70b) | 全部署統一、高速・低コスト |
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
GROQ_API_KEY=         # Groq APIキー (必須)
JWT_SECRET=           # JWT署名シークレット (必須、32文字以上推奨)
DATABASE_URL=sqlite:///./data/app.db
FRONTEND_URL=http://localhost:3000
API_GATEWAY_URL=http://localhost:4000
AI_ENGINE_URL=http://localhost:8000
```

## タスク実行順序

Phase 1 (並列): tasks/00-setup.md + tasks/01-database.md
Phase 2 (並列): tasks/02-auth.md + tasks/03-llm-router.md
Phase 3 (依存): tasks/04-agent-framework.md
Phase 4 (並列): tasks/05-governance.md + tasks/06-frontend.md + tasks/07-file-access.md
Phase 5 (最終): tasks/08-integration.md
