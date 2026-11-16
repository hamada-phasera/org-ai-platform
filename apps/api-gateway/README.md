# api-gateway

Fastify（Node.js 20 / TypeScript）の API サーバ。ポート 4000。
ブラウザからの全リクエストの入口で、認証・権限・DB アクセス・ファイル保存・外部連携・
エージェントのステップ実行・定期実行・Stripe を担う。LLM は直接呼ばず、必ず ai-engine を経由する。

全体の中での位置づけは [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) を参照。

## 主要ディレクトリ

| パス | 内容 |
|---|---|
| `src/index.ts` | アプリの組み立て（CORS・JWT・multipart・websocket）、ルート登録、`/health` `/ready`、起動時処理 |
| `src/config/env.ts` | 環境変数の唯一の読み口（`envSchema` / `ENV_DEFAULTS` / `config`） |
| `src/middleware/auth.ts` | `requireAuth`（JWT 検証 + 解約後の読み取り専用判定）、`requireRole` / `requireAdmin` / `requireOwner` |
| `src/routes/` | `/api/<領域>` のルート。`accounting/` `sales/` `sns/` `analytics/` `inbox/` は部署・機能ごとのまとまり |
| `src/services/` | ドメインロジック（step-runner, task-executor, capability-resolver, schedule-dispatcher, rag, adapters, http-node, inbox, billing, storage, lifecycle など） |
| `src/utils/` | `http-error.ts`（`sendError`）、`logger.ts`（`createLogger`）、`prisma.ts`、`fileExtractor.ts` |
| `src/**/__tests__/` | サービス・ユーティリティの単体テスト |
| `tests/` | ルートのテスト（`app.inject()`）と領域ごとのテスト |

## コマンド

ルートで `npm install` 済み・`npm run prisma:generate` 済みの前提。

```bash
npm run dev          # tsx watch（.env は自動で読まないので、先に set -a; source ../../.env; set +a）
npm run build        # dist/ に出力（tsconfig.build.json。テストは含めない）
npm start            # node dist/index.js
npm run typecheck    # src（tsconfig.json）→ テスト込み（tsconfig.test.json）
npm test             # vitest run
npm run test:coverage
npm run lint
```

## 環境変数

`src/config/env.ts` の `envSchema` が一覧、`ENV_DEFAULTS` が既定値。説明はルートの [.env.example](../../.env.example)（`[gw]` の付いたもの）。

- 必須: `JWT_SECRET`（32 文字以上。未満だと起動時に例外）、`DATABASE_URL`
- ai-engine と組で使う: `AI_ENGINE_URL`、`INTERNAL_API_TOKEN`（両側に同じ値）
- 本番で実質必須: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（無いとローカル保存になり Render では消える）

`process.env` を直接読まず、`config.*` を使うこと（getter で毎回読み直すのでテストの差し替えが効く）。

## 規約

- エラーは `sendError(reply, status, code, message)` で `{ success: false, error: { code, message } }` を返す。
- ログは `createLogger('scope')`。`console.*` を直接書かない。秘密の値は出さない。
- 認証が要るルートは `preHandler: requireAuth`（認証系・webhook を除く全ルート）。

## テスト

- prisma は `vi.mock('../../src/utils/prisma', ...)` でモックし、DB なしで回す。
- 外部 HTTP（ai-engine・n8n・Stripe・Slack/Google）は `fetch` のモックで置き換える。
- テストも型チェック対象（`tsconfig.test.json`。vitest の ESM 前提で module だけ esnext）。
