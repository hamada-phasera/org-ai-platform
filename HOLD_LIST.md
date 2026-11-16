# HOLD_LIST — 未使用判定だが削除を保留したもの

knip（`npx -y knip@5`、ルートの `knip.json` で `ignoreExportsUsedInFile: true`）が
未使用と判定したもののうち、**確実に未使用とは言い切れない／担当外**のため残したもの。

## ファイル

| 項目 | 理由 |
|---|---|
| `apps/web/demo/orb-gen/build-gen.mjs`, `apps/web/demo/orb-gen/gen-export.mts` | 開発用のデモ生成スクリプト。手動実行される前提でエントリから参照されない |
| `apps/web/demo/verify/rm-test.css`, `apps/web/demo/verify/safari-test.css` | ブラウザ検証用の手動テスト素材 |
| `design-canvas/apply-sidebar.mjs`, `design-canvas/build-accent-compare.mjs`, `design-canvas/stripe-v3/build-stripe.mjs` | design-canvas は作業範囲外（手動実行のデザインツール） |
| `docs/pricing/build-deck.mjs` | docs は別担当。手動で資料を生成するスクリプト |
| `packages/db-schema/prisma/seed-capabilities.ts` | `ts-node` で手動実行する seed の可能性が高い（package.json の `seed` は seed.ts のみだが、運用手順で使われうる） |

## 依存

| 項目 | 理由 |
|---|---|
| `apps/api-gateway`: `mammoth`, `pdf-parse` | `src/utils/fileExtractor.ts` で `new Function('m','return import(m)')` による動的 import。静的解析では見えない |
| `apps/api-gateway`: `@types/ws` | `@fastify/websocket` の型定義が `ws` を import しており、WebSocket ハンドラの型解決に必要 |
| `apps/web`: `@types/lodash` | knip の初回レポートでは未使用だったが、`recharts` の型定義（`generateCategoricalChart.d.ts`）が `lodash` を import しており、web は `skipLibCheck` 無しのため削除すると `tsc` が TS7016 で落ちる（削除して確認済み） |

## export

| 項目 | 理由 |
|---|---|
| `api-gateway/src/services/http-node/client.ts`: `resetHttpNodeAgent` | テスト用のリセットフック（現状どのテストからも未参照だが、モジュール内の keep-alive Agent を作り直す意図的な口） |
| `api-gateway/src/services/storage/driver.ts`: `resetStorageDrivers` | 同上。env を差し替えたテストでドライバのキャッシュを捨てるための口 |
| `api-gateway/src/routes/accounting/shared.ts`: `jstDateOnly` | 「保存する日付は必ずこれを通す」という規約を持つ日付ヘルパー。今は未使用だが、日付保存を追加するときの正しい入口として残す |
| `api-gateway/src/routes/sales/pipeline-core.ts`: `Deal`（型） | API レスポンス形の定義（ドキュメントとしての型）。`pipeline.ts` から型として再参照される |
| `web/src/components/Analytics/kpiEvents.ts`: `deriveCostUsd`, `PLACEHOLDER_MODEL_RATE_USD_PER_1K`, `KpiEventKind`, `DepartmentKpi` | gateway `routes/analytics/kpi-events.ts` の契約ミラー（A-2 画面 / A-3 集計 API 用に提案中の形）。統合フェーズで使う前提のため残す |

## knip の設定について

- `ignoreExportsUsedInFile: true` にした。**同じファイル内で使われている export** は未使用扱いしない
  （export を外すだけの差分が大量に出て、レビューの妨げになるため）。
- 型の export（`Unused exported types`）は、上記設定で 4 件まで減った。残りは上表のとおり保留。
