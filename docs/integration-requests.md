# 共有資産の変更要求（integration-requests）

> 各部署は `packages/shared/`（共有型・共通コード）を直接編集しない。
> 変更が必要になったら、このファイルに要求を追記してコミットし、ローカルモックで作業を継続する。
> オーガナイザー（統合エージェント）が `feat/integration` で対応し、人間承認後にマージする。
> 対応完了後、オーガナイザーは該当部署に「rebase してください」と進捗ボード経由で指示する。

## 記入フォーマット

```markdown
## #N [部署] 要求タイトル
- 要求日: 2026-07-XX
- 内容: 追加/変更したい型・インターフェースの具体内容
- 理由: なぜ共有化が必要か（どの部署が使うか）
- 暫定対応: どこにローカルモックを置いて作業継続しているか
- ステータス: 未対応 / 対応中 / 完了
```

---

<!-- 以下に各部署が追記する。番号は連番。 -->

## #1 [営業] Deal / PipelineStage の共有型 + Prisma モデル追加
- 要求日: 2026-07-07
- 内容:
  - `packages/shared-types` に以下を追加してほしい:
    ```ts
    export const PIPELINE_STAGES = ['LEAD', 'NEGOTIATION', 'PROPOSAL', 'WON'] as const;
    export type PipelineStage = (typeof PIPELINE_STAGES)[number]; // リード→商談→提案→受注
    export interface Deal {
      id: string; orgId: string; title: string;
      company: string | null; amount: number; stage: PipelineStage;
      ownerId: string | null; createdAt: string; updatedAt: string;
    }
    ```
  - `packages/db-schema/prisma/schema.prisma` に `Deal` モデル（上記フィールド、`stage String @default("LEAD")`、`@@index([orgId, stage])`、Organization リレーション）を追加してほしい。
- 理由: 営業パイプライン（商談ステージ管理）の正本を DB に置くため。将来 SNS/分析からも商談データを参照する可能性がある（部署横断KPI）。
- 暫定対応: `apps/api-gateway/src/routes/sales/pipeline.ts` にローカル型 + orgId 単位のインメモリ Map ストアで実装済み（R1 縦切り）。DB 化されたら prisma 実装に差し替える。
- ステータス: 未対応

## #2 [営業] 配線要求 — SalesPage ルート + sales pipeline ルート登録（B が実施）
- 要求日: 2026-07-07
- 内容:
  - **フロント (`apps/web/src/App.tsx`)**: 保護レイアウト配下に `<Route path="sales" element={<SalesPage />} />` を追加（`import SalesPage from './pages/SalesPage'`）。ナビ表示が必要なら `components/Layout.tsx` / `Navigation/**` に「営業部」項目（key='SALES', icon='🤝'）を追加。
  - **API (`apps/api-gateway/src/index.ts`)**: 他ルートと同様に登録:
    ```ts
    import { salesPipelineRoutes } from './routes/sales/pipeline';
    // ...async function start() 内、dashboardRoutes 登録の近くに:
    await app.register(salesPipelineRoutes, { prefix: '/api/sales/pipeline' });
    ```
- 理由: 所有 vs 配線の分離（共有コントラクト v0）に従い、根の配線ファイルは部署が触らず B が配線するため。C 中はページ/ルート単体で動作確認済み（SalesPage は既存 `/agents`・`/tasks` を読むだけで単体レンダー可能、pipeline ルートは Vitest の inject で検証済み 12/12 pass）。
- 暫定対応: 配線なしでも SalesPage は未リンク状態で存在、pipeline ルートは未登録のまま単体テスト済み。
- ステータス: 未対応

## #3 [営業→統合/SNS] 共有コントラクト v0 の department 値域が実装と不一致（注意喚起）
- 要求日: 2026-07-07
- 内容: `docs/tasks.md`「🔒 共有コントラクト v0」は department 値域を `SALES | ANALYTICS | SNS | GENERAL` と規定しているが、実装の `packages/shared-types` の `AgentDepartment` は `'SALES' | 'MARKETING' | 'ACCOUNTING' | 'ANALYTICS' | 'GENERAL'` で、**`SNS` は存在せず `MARKETING`** である（`apps/api-gateway/src/routes/agents.ts` の検証配列はさらに `ASSISTANT` を含む）。SNS 部署の `department` タグ付けが v0 のままだと実データと噛み合わない。
- 理由: 営業スライス実装中に発見した横断的な不整合。SNS 部署の実装方針（`MARKETING` を使うか、`SNS` を新設して shared-types/agents.ts/prisma default を揃えるか）を B が確定する必要がある。営業自身は `SALES`（両者に存在）を使うため影響なし。
- 暫定対応: 営業は `SALES` 固定で実装（影響なし）。SNS 部署・B の判断待ち。
- ステータス: 未対応
