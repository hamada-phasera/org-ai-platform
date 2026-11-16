# web

React 18 + Vite + TypeScript の SPA（社長UI）。dev サーバはポート 3000。本番は Vercel。
API は api-gateway の `/api/*` だけを呼ぶ（LLM を直接呼ばない・シークレットを持たない）。

## 主要ディレクトリ

| パス | 内容 |
|---|---|
| `src/App.tsx` | ルーティング（`/dashboard` `/chat` `/inbox` `/agents` `/sales` `/sns` `/accounting` `/analytics` `/governance` `/deliverables` `/tasks` `/settings` など） |
| `src/pages/` | ルート単位の画面 |
| `src/components/` | 機能別のコンポーネント。`ui/` `shell/` `motion/` は共通部品 |
| `src/store/` | zustand のストア（auth / chat / 部署フィルタ / 成果物） |
| `src/services/api.ts` | axios インスタンス（`VITE_API_URL`、JWT を自動付与） |
| `src/hooks/`, `src/utils/` | フック・純粋関数（テストはここが中心） |
| `src/taskmanager/` | タスク管理画面（dexie = IndexedDB を使う） |
| `demo/` | 手動で使うデモ・ブラウザ検証素材（ビルド・lint 対象外） |
| `scripts/check-design-tokens.mjs` | デザイントークン違反の検査（`npm run check:tokens`） |

デザインのルールはルートの [DESIGN.md](../../DESIGN.md)。

## コマンド

```bash
npm run dev            # vite（/api は localhost:4000 へ proxy。VITE_PROXY_TARGET で変更可）
npm run build          # vite build → dist/
npm run preview
npm run typecheck      # tsc --noEmit（テストも含む）
npm test               # vitest run
npm run test:coverage
npm run lint
npm run check:tokens
```

`@org-ai/shared-types` は `import` 条件で `src/index.ts` を直接読むので、事前ビルドは不要。

## 環境変数（ビルド時に埋め込み）

`apps/web/.env.local`（ローカル）か Vercel のビルド環境変数に書く。

| 変数 | 既定 | 用途 |
|---|---|---|
| `VITE_API_URL` | `/api` | API のベース URL |
| `VITE_WS_URL` | ページと同じホスト | タスク進捗の WebSocket |
| `VITE_METRICS_URL` | dev のみ `http://localhost:8080` | usage-metrics-svc の直叩き（gateway 経由に失敗したとき） |
| `VITE_PROXY_TARGET` | `http://localhost:4000` | dev サーバの `/api` proxy 先（`vite.config.ts`） |

## テスト

`src/**/__tests__/*.test.ts`。vitest で純粋関数（チャットの進捗表示・スケジュール・ワークフロー図の変換・金額表示など）を検証する。
