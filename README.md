# FLOW — みんなの AI オフィス

> 社長が指示を出すと、**営業部・マーケ部・経理部の各 AI が分担して実行する**、中小企業向けの組織型 AI エージェント基盤。<br/>
> *An "AI office" for small businesses: one instruction from the owner, dispatched to department agents.*

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Groq](https://img.shields.io/badge/Groq-LLM-F55036?style=flat-square)](https://groq.com/)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![Turborepo](https://img.shields.io/badge/Turborepo-EF4444?style=flat-square&logo=turborepo&logoColor=white)](https://turbo.build/)

---

## 概要

社長（管理者）が自然文で指示を出すと、内容に応じて **担当部署の AI が自動で選ばれ**、メール作成・SNS 投稿・経費レポートなどを分担実行する。中小企業の「人を増やさずに部署機能を持つ」状態を、AI エージェントの組織で再現することを狙ったプラットフォーム。

- **入力はひとつ** — 社長が指示を書くだけ。ルーティングは内容から自動判定
- **部署＝エージェント** — 営業 / マーケ / 経理 / 総合が、それぞれの役割で応答
- **monorepo 構成** — フロント・ゲートウェイ・AI エンジンを 1 リポジトリで統合運用

---

## スクリーンショット

| ログイン (Glass UI) | 社長ダッシュボード（部署 AI） | エージェント詳細 |
| :---: | :---: | :---: |
| ![ログイン](docs/screenshots/01-login.png) | ![ダッシュボード](docs/screenshots/02-dashboard.png) | ![エージェント詳細](docs/screenshots/03-agent-chat.png) |

---

## アーキテクチャ

```
┌─────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  web :3000  │ ───▶ │ api-gateway :4000 │ ───▶ │  ai-engine :8000   │
│  React SPA  │ ◀─── │  Fastify          │ ◀─── │  FastAPI · Groq    │
│  (Glass UI) │      │  認証 / API / DB   │      │  部署ルーティング   │
└─────────────┘      └──────────────────┘      └────────────────────┘
                            │
                       Prisma / SQLite
```

| サービス | ポート | 役割 |
| --- | --- | --- |
| `web` | 3000 | React SPA（フロントエンド・Glass UI） |
| `api-gateway` | 4000 | Fastify（認証・API・DB アクセス） |
| `ai-engine` | 8000 | FastAPI（Groq LLM・部署エージェント） |

---

## 部署 AI の使い方

チャット画面でメッセージを送ると、内容に応じて自動的に部署が選ばれる。

| 入力例 | 担当部署 |
| --- | --- |
| 「見込み客へのメールを書いて」 | 営業部 |
| 「Twitter の投稿文を作って」 | マーケ部 |
| 「今月の経費レポートをまとめて」 | 経理部 |
| 「会議のアジェンダを作って」 | 総合 |

---

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| フロントエンド | React (SPA) / TypeScript / Glass UI |
| ゲートウェイ | Fastify / JWT 認証 / Prisma |
| AI エンジン | FastAPI (Python 3.11) / Groq LLM |
| データベース | SQLite（Prisma migrate / seed） |
| モノレポ | Turborepo / npm workspaces |
| インフラ | Docker Compose / Render / Vercel |

**規模**: TypeScript 81% / Python 7% を中心としたフルスタック monorepo（web・api-gateway・ai-engine の 3 サービス）。

---

## セットアップ

### 前提条件

- Node.js 20+
- Python 3.11+
- Groq API キー（[console.groq.com](https://console.groq.com)）

### クイックスタート（Docker Compose）

```bash
cp .env.example .env          # GROQ_API_KEY, JWT_SECRET を設定
docker-compose up --build
# ブラウザで http://localhost:3000 を開く
```

### 個別起動（開発時）

```bash
# 1. 環境変数
cp .env.example .env          # GROQ_API_KEY / JWT_SECRET

# 2. 依存インストール
cd apps/api-gateway && npm install && cd ../..
cd apps/web         && npm install && cd ../..
cd packages/shared-types && npm install && cd ../..
cd packages/db-schema    && npm install && cd ../..

# 3. AI エンジン（Python）
cd apps/ai-engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && cd ../..

# 4. DB マイグレーション & シード
mkdir -p data
cd packages/db-schema
DATABASE_URL="file:../../data/app.db" npx prisma migrate dev --name init
DATABASE_URL="file:../../data/app.db" npx ts-node prisma/seed.ts
cd ../..
```

3 つのターミナルで `ai-engine` → `api-gateway` → `web` を起動。

```bash
# ai-engine
cd apps/ai-engine && source .venv/bin/activate
GROQ_API_KEY=your_key uvicorn app.main:app --reload --port 8000

# api-gateway
cd apps/api-gateway
DATABASE_URL="file:../../data/app.db" JWT_SECRET=your_secret AI_ENGINE_URL=http://localhost:8000 npm run dev

# web
cd apps/web && npm run dev
```

### デモアカウント

- メール: `admin@demo.com`
- パスワード: `demo1234`

---

## 環境変数

| 変数名 | 必須 | 説明 |
| --- | :---: | --- |
| `GROQ_API_KEY` | ✅ | Groq API キー |
| `JWT_SECRET` | ✅ | JWT 署名シークレット（32 文字以上） |
| `DATABASE_URL` | – | SQLite パス（デフォルト: `file:./data/app.db`） |
| `AI_ENGINE_URL` | – | ai-engine の URL（デフォルト: `http://localhost:8000`） |
| `FRONTEND_URL` | – | フロントエンドの URL（CORS 用） |

---

## このプロジェクトで見せられること

- **マルチサービス設計** — フロント / ゲートウェイ / AI エンジンを役割分割した monorepo 運用
- **エージェントのルーティング設計** — 自然文 → 担当部署の自動振り分け
- **LLM プロダクト化** — Groq を用いた応答生成と、部署ごとのプロンプト設計
- **インフラ一気通貫** — Docker Compose / Render / Vercel でのデプロイ構成

---

*※ 本リポジトリはポートフォリオ目的で公開しています。実運用の鍵・本番環境情報は含まれません。*
