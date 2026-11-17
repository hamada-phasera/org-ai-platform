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

## 最短で動かす（Docker だけ）

```bash
git clone <このリポジトリの URL> org-ai-platform && cd org-ai-platform
docker compose up --build
# http://localhost:3000 を開いて「新規登録」
```

Docker Compose **v2.24 以上**が要る（`env_file` の `required: false` を使うため。`docker compose version` で確認）。
`.env` は要らない（開発用の既定値が `docker-compose.yml` に入っている。⚠️ 本番では使わない値）。
AI に答えさせるには `.env` に `ANTHROPIC_API_KEY`（か `GEMINI_API_KEY`）を書いて `docker compose up -d` し直す。
n8n と usage-metrics-svc は任意: `docker compose --profile n8n --profile metrics up --build`。

## セットアップ（開発・ホットリロード）

### 前提

- Node.js 22.19+（npm 10。ルートの npm workspaces で一括 install。`.node-version` と `engines` に合わせる）
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
docker compose up -d postgres          # pgvector 入り。postgresql://orgai:orgai-dev-password@localhost:5432/orgai
set -a; source .env; set +a
npm run prisma:generate
npm run migrate:deploy --workspace=packages/db-schema   # スキーマを変えるときは migrate:dev
npm run seed --workspace=packages/db-schema             # デモ組織とユーザーを作る
```

> マイグレーションは pgvector 拡張（`CREATE EXTENSION vector`）を使う。compose の Postgres は `pgvector/pgvector:pg16`。
> 以前の `postgres:16-alpine` の volume（`pgdata`）は使わない（新しい volume は `pgdata16`）。

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
> `scripts/start-dev.sh` は 3 と 4 をまとめて行う（Postgres は先に `docker compose up -d postgres`）。

### デモアカウント

`npm run seed --workspace=packages/db-schema`（`packages/db-schema/prisma/seed.ts`）で作られる。

- メール: `admin@demo.com`
- パスワード: `demo1234`

## Docker Compose の中身

| サービス | 既定で起動 | 公開 | 備考 |
|---|---|---|---|
| postgres | ○ | 127.0.0.1:5432 | `pgvector/pgvector:pg16` |
| ai-engine | ○ | 127.0.0.1:8000 | |
| api-gateway | ○ | 127.0.0.1:4000 | 起動時に `prisma migrate deploy`。`/health` の応答を待ってから web が起動 |
| web | ○ | 3000 | nginx。`/api` と WebSocket を gateway へ中継 |
| n8n | `--profile n8n` | 127.0.0.1:5678 | タグ固定。使うなら `.env` に `N8N_URL=http://n8n:5678` |
| usage-metrics | `--profile metrics` | 127.0.0.1:8080 | 分析画面の部署別集計 |

`.env` を置くとその値が既定値より優先される。設定の食い違い（`envSchema`・`.env.example`・`render.yaml`・compose・Node の版）は
`npm run check:deploy`（`npm test` にも含まれる）で検査する。CI の `compose-smoke` が `.env` 無しで起動 → `/health`・`/ready` → 登録 まで確かめる。

## デプロイ（Vercel・Render）

設定はリポジトリ側が正。プロジェクト側（ダッシュボード）をこの表に合わせる。

| どこ | 項目 | 値 |
|---|---|---|
| Vercel | Root Directory | 空（リポジトリのルート） |
| Vercel | Framework / Build / Output / Install | `vercel.json` に従う（ダッシュボードの上書きは外す） |
| Vercel | Node.js Version | 22.x |
| Vercel | 環境変数 | `VITE_API_URL=https://<gateway>/api`、`VITE_WS_URL=wss://<gateway>` |
| Render | Blueprint | `render.yaml`（Node は `NODE_VERSION=22`） |
| Render | 秘密の値 | `sync: false` のキーをダッシュボードで入れる（`JWT_SECRET`・`N8N_WEBHOOK_AUTH_TOKEN`・`INTERNAL_API_TOKEN` は必須。本番の gateway は公開されている値では起動しない） |

手順（秘密の値・Supabase・Stripe・Render・Vercel・確認・困ったとき）は [docs/DEPLOY.md](docs/DEPLOY.md) の 1 本。

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
| `npm run test:int` | gateway の実 Postgres 統合テスト（`TEST_DATABASE_URL` が無ければスキップ） |

`test:int` 以外のテストは DB・外部 API・シークレットなしで通る（DB と LLM はモック/スタブ）。

### 実 Postgres の統合テスト

`apps/api-gateway/tests/integration/`。空の DB への `prisma migrate deploy`（schema.prisma とのずれも検査）、
DoD の通し（2 社の登録 → 分離 → 容量上限 → 竹の契約 → AI 上限 → トライアル切れで 402）、
`routes/files.ts`・`services/rag.ts` の raw SQL の組織分離を確かめる。Stripe は偽物、埋め込みと ai-engine は呼ばない。

```bash
# pgvector 入りの Postgres 16（例: docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16）
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/flow_test npm run test:int
```

- DB 名は `flow_` で始めること。テストはファイルごとに `<DB 名>_<乱数>` を作ってマイグレーションを当て、終わったら消す
  （`TEST_DATABASE_URL` の DB 自体は無くてよい。同じサーバの `postgres` DB に繋いで作成・削除するので、その権限が要る）
- `npm test` は `TEST_DATABASE_URL` があっても統合テストを回さない（`vitest.config.mts` で除外）

## CI

`.github/workflows/ci.yml` が pull request と main への push で次の 5 ジョブを回す。

- **node**（Node 22）: `npm ci` → `prisma:generate` → `lint` → `typecheck` → `test` → `build`
- **integration**: `pgvector/pgvector:pg16` サービスに向けて `npm run test:int`（`REQUIRE_TEST_DATABASE=1` で全スキップを失敗にする）
- **python**（Python 3.11）: requirements + requirements-dev → `ruff check` → `pytest`
- **go**（go.mod のバージョン）: usage-metrics-svc の `go vet` / `go test`
- **compose-smoke**: `.env` 無しで `docker compose up --build --wait` → `/health`・`/ready` → 登録 1 回

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
| [docs/DEPLOY.md](docs/DEPLOY.md) | デプロイ手順（これだけ。`DEPLOYMENT_RUNBOOK.md` は案内） |
| [docs/security.md](docs/security.md) | レート制限・起動拒否・監査 |
| [docs/llm-provider-tiers.md](docs/llm-provider-tiers.md) | 松竹梅の LLM ルーティング |
| [docs/billing.md](docs/billing.md) | Stripe 決済 |
| [docs/self-serve-integrations.md](docs/self-serve-integrations.md) / [docs/oauth-setup.md](docs/oauth-setup.md) | Slack / Google 連携 |
| [docs/n8n-setup.md](docs/n8n-setup.md) / [docs/n8n-integration-design.md](docs/n8n-integration-design.md) | n8n |
| [docs/capabilities.md](docs/capabilities.md) | Capability Registry |
| [docs/supabase-migration.md](docs/supabase-migration.md) | DB の移行の経緯と Supabase の落とし穴 |
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
