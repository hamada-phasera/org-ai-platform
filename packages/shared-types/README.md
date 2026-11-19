# @org-ai/shared-types

web と api-gateway で共有する型と定数。ここを変えると両方に効く。

主な中身（`src/index.ts`）:

- プランと上限: `PLAN_LIMITS`、`canUpload()`（容量判定はここ 1 か所だけ）、`storageQuotaBytes()`、`usageState()`
- 権限: `UserRole`、`hasRoleAtLeast()`
- エージェント実行: `AgentStepDef`、`AgentRunState`、`APPROVAL_REQUIRED_CAPS`（実行前に人の承認が要る capability）、`LLM_TRANSFORM_STEP`
- 業務ページ: `pages.ts`（zod スキーマ）、`pages-plan.ts`（zod 非依存の定数・上限・文字列の検査）
- 業務フロー（docs/design/canvas-home.md）: `flows.ts`（ノード 7 型・定義・キャンバス配置の zod スキーマ）、`flows-core.ts`（zod 非依存の純粋関数: `topoOrder` `upstreamOf` `outputKeysOf` `renderTemplate` `checkFlowDefinition`）、`flows-plan.ts`（`FLOW_LIMITS` とプランの判定）、`flow-templates.ts`（テンプレート 4 つと `DEFAULT_CANVAS_LAYOUT`。zod 非依存）、`flow-parts.ts`（部品カタログ `FLOW_PARTS`。zod 非依存。入力の検証は flows.ts の `buildPartInputSchema`）。web の初回ロードからは zod を読むファイルを import しない
- カスタム HTTP ノード、受信箱、決済（`ENTITLED_STATUSES` など）、API のエンティティ型（`Task` `AILog` …）

## 解決のされ方

| 利用側 | 読むもの |
|---|---|
| web（vite / vitest） | `exports` の `import` 条件 → `src/index.ts`（ビルド不要） |
| api-gateway の型チェック・dev（tsx） | gateway の `tsconfig.json` の `paths` → `src/index.ts` |
| api-gateway の本番（`node dist/index.js`） | `dist/index.js`（`npm run build` が必要。turbo が先に作る） |

## コマンド

```bash
npm run build          # tsc → dist/（__tests__ は含めない）
npm run typecheck      # src → テスト込み（tsconfig.test.json）
npm test               # vitest run
npm run test:coverage
npm run lint
```

環境変数は読まない。テストは `src/__tests__/`。
