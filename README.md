# FLOW - みんなのAIオフィス

中小企業向けの組織型AIエージェント基盤。社長が指示を出すと、営業部・マーケ部・経理部の各AIが分担・実行する。

## スクリーンショット

| ログイン (Glass UI) | 社長ダッシュボード（部署AI） | エージェント詳細 |
|:---:|:---:|:---:|
| ![ログイン](docs/screenshots/01-login.png) | ![ダッシュボード](docs/screenshots/02-dashboard.png) | ![エージェント詳細](docs/screenshots/03-agent-chat.png) |

## 構成

| サービス | ポート | 役割 |
|---|---|---|
| web | 3000 | React SPA (フロントエンド) |
| api-gateway | 4000 | Fastify (認証・API・DBアクセス) |
| ai-engine | 8000 | FastAPI (Claude/Gemini LLM・エージェント) |

## セットアップ

### 前提条件
- Node.js 20+
- Python 3.11+
- Anthropic APIキー ([console.anthropic.com](https://console.anthropic.com))
- （任意）Gemini APIキー — STARTER/PROプランのルーティング用。詳細は docs/llm-provider-tiers.md

### 1. 環境変数を設定

```bash
cd org-ai-platform
cp .env.example .env
# .envを編集してANTHROPIC_API_KEYとJWT_SECRETを設定
```

### 2. 依存パッケージをインストール

```bash
# Node.js (api-gateway + web)
cd apps/api-gateway && npm install && cd ../..
cd apps/web && npm install && cd ../..
cd packages/shared-types && npm install && cd ../..
cd packages/db-schema && npm install && cd ../..

# Python (ai-engine)
cd apps/ai-engine
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

### 3. DBマイグレーション & シードデータ

```bash
mkdir -p data
cd packages/db-schema
DATABASE_URL="file:../../data/app.db" npx prisma migrate dev --name init
DATABASE_URL="file:../../data/app.db" npx ts-node prisma/seed.ts
cd ../..
```

### 4. サービスを起動

**ターミナル1 — ai-engine:**
```bash
cd apps/ai-engine
source .venv/bin/activate
ANTHROPIC_API_KEY=your_key uvicorn app.main:app --reload --port 8000
```

**ターミナル2 — api-gateway:**
```bash
cd apps/api-gateway
DATABASE_URL="file:../../data/app.db" JWT_SECRET=your_secret AI_ENGINE_URL=http://localhost:8000 npm run dev
```

**ターミナル3 — web:**
```bash
cd apps/web
npm run dev
```

ブラウザで http://localhost:3000 を開く。

### デモアカウント
- メール: `admin@demo.com`
- パスワード: `demo1234`

## Docker Compose (全サービス一括起動)

```bash
cp .env.example .env  # ANTHROPIC_API_KEY, JWT_SECRETを設定
docker-compose up --build
```

## 部署AIの使い方

チャット画面でメッセージを送ると、内容に応じて自動的に部署が選ばれる：

| 入力例 | 担当部署 |
|---|---|
| 「見込み客へのメールを書いて」 | 営業部 |
| 「Twitterの投稿文を作って」 | マーケ部 |
| 「今月の経費レポートをまとめて」 | 経理部 |
| 「会議のアジェンダを作って」 | 総合 |

## 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| ANTHROPIC_API_KEY | ✅ | Anthropic APIキー |
| GEMINI_API_KEY | 任意 | 梅/竹プラン用（未設定なら全プランClaude） |
| JWT_SECRET | ✅ | JWT署名シークレット (32文字以上) |
| DATABASE_URL | - | SQLiteパス (デフォルト: file:./data/app.db) |
| AI_ENGINE_URL | - | ai-engineのURL (デフォルト: http://localhost:8000) |
| FRONTEND_URL | - | フロントエンドのURL (CORS用) |
