# FLOW - みんなのAIオフィス

中小企業向けの組織型AIエージェント基盤。社長が指示を出すと、営業部・マーケ部・経理部などの各部署AIが分担・実行・報告する。
AIガバナンス（AI 入出力のログ・PII 検知・リスク検知）を補助機能として内蔵する。

## スクリーンショット

| ログイン (Glass UI) | 社長ダッシュボード（部署AI） | エージェント詳細 |
|:---:|:---:|:---:|
| ![ログイン](docs/screenshots/01-login.png) | ![ダッシュボード](docs/screenshots/02-dashboard.png) | ![エージェント詳細](docs/screenshots/03-agent-chat.png) |

## 構成

| サービス | 場所 | ポート | 役割 | 本番 |
|---|---|---|---|---|
| web | `apps/web` | 3000 | React 18 + Vite の SPA（社長UI） | Vercel |
| api-gateway | `apps/api-gateway` | 4000 | Fastify。認証・API・DB アクセス・WebSocket・定期実行・外部連携 | Render |
| ai-engine | `apps/ai-engine` | 8000 | FastAPI。Intent 分類・部署エージェント・LLMRouter・PII 検知・AILog | Render |
| n8n（任意） | `apps/n8n-workflows` | 5678 | ワークフロー実行の加速レイヤー。落ちていても ai-engine にフォールバック | Render |
| usage-metrics-svc（任意） | `usage-metrics-svc` | 8080 | Go。AILog を読んで部署別のコスト/レイテンシを集計（読み取り専用） | 別運用 |
| DB | `packages/db-schema` | 5432 | PostgreSQL + pgvector（Prisma）。本番は Supabase | Supabase |

全体像とデータの流れは [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照。

## セットアップ（ローカル）

### 前提

- Node.js 20+（npm 10。ルートの npm workspaces で一括 install）
- Python 3.11+
- Docker（ローカルの Postgres 用。docker-compose）
- Anthropic API キー（[console.anthropic.com](https://console.anthropic.com)）
- （任意）Gemini API キー — 梅/竹プランのルーティングと RAG の埋め込みに使う。詳細は [docs/llm-provider-tiers.md](docs/llm-provider-tiers.md)
- （任意）Go 1.25+ — usage-metrics-svc を触る場合

### 1. 環境変数

```bash
cp .env.example .env
# 最低限: ANTHROPIC_API_KEY と JWT_SECRET（32 文字以上。openssl rand -hex 32）
```

変数ごとの意味・既定値・どのサービスが読むかは `.env.example` のコメントにまとめてある。

> ⚠️ api-gateway と prisma は `.env` を自動では読まない（ai-engine だけが `python-dotenv` で読む）。
> 以下のコマンドは、先に `set -a; source .env; set +a` でシェルに読み込んでおく前提で書いている。

### 2. 依存パッケージ

```bash
# Node（web / api-gateway / packages/* をまとめて）
npm install

# Python（ai-engine）
cd apps/ai-engine
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cd ../..
```

### 3. DB（Postgres）の起動とマイグレーション

```bash
docker compose up -d postgres          # postgresql://orgai:orgai-dev-password@localhost:5432/orgai
set -a; source .env; set +a
npm run prisma:generate
npm run migrate:deploy --workspace=packages/db-schema   # スキーマを変えるときは migrate:dev
npm run seed --workspace=packages/db-schema             # デモ組織とユーザーを作る
```

> ⚠️ マイグレーションは pgvector 拡張（`CREATE EXTENSION vector`）を使う。docker-compose の
> `postgres:16-alpine` には pgvector が入っていないため、この手順は失敗する。ローカルでは
> pgvector 入りのイメージ（例: `pgvector/pgvector:pg16`）に差し替えて起動すること。
> 既知の問題として [docs/maintenance/cleanup-hold-list.md](docs/maintenance/cleanup-hold-list.md) に記録してある。

### 4. 各サービスを起動

```bash
# ターミナル1 — ai-engine（.env を自分で読む）
cd apps/ai-engine && .venv/bin/uvicorn app.main:app --reload --port 8000

# ターミナル2 — api-gateway
set -a; source .env; set +a
npm run dev --workspace=apps/api-gateway

# ターミナル3 — web（/api は vite の proxy で localhost:4000 へ）
npm run dev --workspace=apps/web
```

`npm run dev`（ルート）は api-gateway と web を concurrently でまとめて起動する（ai-engine は別途）。
ブラウザで http://localhost:3000 を開く。

> WebSocket（タスクの進捗表示）は既定でページと同じホストに繋ぐ。vite の dev サーバ経由で繋がらない場合は
> `apps/web/.env.local` に `VITE_WS_URL=ws://localhost:4000` を書く。
>
> `scripts/start-dev.sh` は SQLite 時代の DB 初期化処理が残っており、現状の Postgres 構成とは合わない（既知の問題）。

### デモアカウント

`npm run seed --workspace=packages/db-schema`（`packages/db-schema/prisma/seed.ts`）で作られる。

- メール: `admin@demo.com`
- パスワード: `demo1234`

## Docker Compose（全サービス一括起動）

```bash
cp .env.example .env  # ANTHROPIC_API_KEY, JWT_SECRET を設定
docker compose up --build
```

postgres / n8n / ai-engine / api-gateway / web が起動する。api-gateway のコンテナは起動時に
`prisma migrate deploy` を実行する（上の pgvector の注意はこちらにも当てはまる）。

## テスト・lint・型チェック

ルートから実行する。TypeScript はすべての workspace（web / api-gateway / shared-types / db-schema）が対象。

| コマンド | 内容 |
|---|---|
| `npm run lint` | ESLint（ルートの `eslint.config.js`。TS のみ） |
| `npm run typecheck` | 各 workspace の `tsc --noEmit`（api-gateway と shared-types はテストコードも含む） |
| `npm test` | 各 workspace の vitest |
| `npm run test:coverage` | 同上をカバレッジ付きで |
| `npm run build` | turbo で shared-types → api-gateway / web をビルド |
| `npm run prisma:generate` | Prisma Client の生成（型チェック・テストの前提） |
| `npm run lint:ai` | ai-engine の ruff（`apps/ai-engine/.venv` が必要） |
| `npm run typecheck:ai` | ai-engine の mypy |
| `npm run test:ai` | ai-engine の pytest |
| `npm run test:go` | usage-metrics-svc の `go vet` と `go test` |

どのテストも DB・外部 API・シークレットなしで通る（DB と LLM はモック/スタブ）。

## CI

`.github/workflows/ci.yml` が pull request と main への push で次の 3 ジョブを回す。

- **node**（Node 20）: `npm ci` → `prisma:generate` → `lint` → `typecheck` → `test` → `build`
- **python**（Python 3.11）: requirements + requirements-dev → `ruff check` → `pytest`
- **go**（go.mod のバージョン）: usage-metrics-svc の `go vet` / `go test`

ほかに `keepalive.yml` / `db-keepalive.yml`（稼働維持）と `ontology-check.yml`（語彙のズレ検査）がある。

## ディレクトリ構成

```
org-ai-platform/
├── apps/
│   ├── web/                 # React SPA（README あり）
│   ├── api-gateway/         # Fastify API（README あり）
│   ├── ai-engine/           # FastAPI + LLMRouter（README あり）
│   └── n8n-workflows/       # n8n にインポートするワークフロー JSON
├── packages/
│   ├── shared-types/        # web / gateway 共有の型・定数（README あり）
│   └── db-schema/           # Prisma スキーマ・マイグレーション・seed（README あり）
├── usage-metrics-svc/       # Go の集計サービス（README あり）
├── tests/fixtures/          # gateway と ai-engine が共有する契約テストのフィクスチャ
├── ontology/                # 語彙の定義と観測結果（ontology-check が検査）
├── scripts/                 # 運用スクリプト（n8n / Render / Supabase / ontology）
├── docs/                    # 設計・運用ドキュメント
├── design-canvas/ marketing/ # デザインのモックと販促物（ビルド対象外）
├── tasks/                   # 初期構築時のエージェントチーム用タスク定義
├── docker-compose.yml  render.yaml  vercel.json
└── .env.example
```

## ドキュメント索引

| ドキュメント | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | コンポーネント・データフロー・設定・エラー/ログ/テストの方針 |
| [CLAUDE.md](CLAUDE.md) | 開発ルールと各機能の設計判断（経理・決済・ファイル保存・自動化） |
| [DESIGN.md](DESIGN.md) | デザインシステム |
| [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) / [docs/DEPLOY.md](docs/DEPLOY.md) | デプロイ手順 |
| [docs/llm-provider-tiers.md](docs/llm-provider-tiers.md) | 松竹梅の LLM ルーティング |
| [docs/billing.md](docs/billing.md) | Stripe 決済 |
| [docs/self-serve-integrations.md](docs/self-serve-integrations.md) / [docs/oauth-setup.md](docs/oauth-setup.md) | Slack / Google 連携 |
| [docs/n8n-setup.md](docs/n8n-setup.md) / [docs/n8n-integration-design.md](docs/n8n-integration-design.md) | n8n |
| [docs/capabilities.md](docs/capabilities.md) | Capability Registry |
| [docs/supabase-migration.md](docs/supabase-migration.md) | Neon → Supabase 移行 |
| [docs/test-requirements.md](docs/test-requirements.md) | テスト要件 |
| [docs/maintenance/cleanup-hold-list.md](docs/maintenance/cleanup-hold-list.md) | 整理で見送った項目と既知の問題 |
| [docs/MASTERY_GUIDE.md](docs/MASTERY_GUIDE.md) | 開発・運用の総合ガイド（作成時点の内容。最新は上記を優先） |

## 部署AIの使い方

チャット画面でメッセージを送ると、内容に応じて自動的に部署が選ばれる：

| 入力例 | 担当部署 |
|---|---|
| 「見込み客へのメールを書いて」 | 営業部 |
| 「Twitterの投稿文を作って」 | マーケ部 |
| 「今月の経費レポートをまとめて」 | 経理部 |
| 「会議のアジェンダを作って」 | 総合 |
