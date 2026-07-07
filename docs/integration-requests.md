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

## #1 [ANALYTICS] KPIイベントスキーマ v1（提案・発火は後続R2）
- 要求日: 2026-07-07
- 内容: `packages/shared-types/src/index.ts` に、部署別KPI集計の共通語彙となる **KPIイベント型** を追加してほしい（提案。命名・確定は統合フェーズBで）。既存テーブル（AILog / Task / ExecutionLog / RiskEvent）から**導出可能な範囲のみ**で設計する。discriminated union 形:
  ```ts
  // occurredAt は ISO文字列。department は AgentDepartment（下記 #2 の確定値域に従う）。
  interface KpiEventBase { id: string; orgId: string; department: AgentDepartment; occurredAt: string; }
  type KpiEvent =
    | (KpiEventBase & { kind: 'llm.call';           provider: string; model: string; tokens: number | null; latencyMs: number | null; riskScore: number | null; costUsd: number | null /* 導出値 */ })
    | (KpiEventBase & { kind: 'task.completed';      taskId: string; agentId: string | null; taskType: string | null; latencyMs: number | null /* executedAt-createdAt 導出 */ })
    | (KpiEventBase & { kind: 'task.failed';         taskId: string; agentId: string | null; taskType: string | null; lastError: string | null })
    | (KpiEventBase & { kind: 'capability.executed'; capabilityId: string | null; status: string; errorType: string | null })
    | (KpiEventBase & { kind: 'risk.flagged';        riskType: RiskType; severity: RiskSeverity; aiLogId: string | null });

  // 部署ダッシュボード（A-2/A-3）が上記を roll-up する集計形:
  interface DepartmentKpi { department: AgentDepartment; executions: number; succeeded: number; failed: number; successRate: number | null; costUsd: number | null; avgLatencyMs: number | null; riskEvents: number; }
  ```
- 理由: A-2（部署別分析画面）/ A-3（usage-metrics-svc 部署別集計, Go）/ 既存 governance が「実行数・成功率・コスト・レイテンシ・リスク」を**同じ語彙**で扱うため。他部署（営業/マーケ）は発火側になるので共有型が必要。
- **重要な設計上の制約（DB実態に基づく）**:
  - **コストのカラムは全テーブルに存在しない** → `costUsd` は `AILog.tokens × モデル別レート` の**導出値**。`AILog.tokens` は入出力合算・NULL可のため概算。レート表は要人間確認（本提案では暫定 placeholder）。
  - `AILog` には success/status・agentId・taskId が無い → LLM呼び出しをTask/Agentに紐付け不可。**成功/失敗は `Task.status`（DONE/FAILED）由来**、能力実行は `ExecutionLog.status/errorType` 由来。
  - `ExecutionLog` には department が無い → `capability.executed` の department は現状 GENERAL/不明になりうる（将来 ExecutionLog.department 追加を別途検討）。
  - 発火（イベント書き込み）は本R1では行わない。R2(A-4)で `tests/business/` に本スキーマ準拠の発火テストを追加予定。
- 暫定対応: `apps/web/src/components/Analytics/kpiEvents.ts` にローカルモック型＋`deriveCostUsd()`（placeholderレート）を配置し、A-2/A-4 はそれを参照して先行。shared-types 昇格後に import 差し替え。
- ステータス: 未対応

## #2 [ANALYTICS] 共有コントラクト `department` 値域が実コードと不一致（要修正）
- 要求日: 2026-07-07
- 内容: `docs/tasks.md` の「🔒 共有コントラクト v0」は `department 値域: SALES | ANALYTICS | SNS | GENERAL` と記載しているが、**実コードの正本** `packages/shared-types/src/index.ts` の `AgentDepartment` は `SALES | MARKETING | ACCOUNTING | ANALYTICS | GENERAL`。`apps/web/src/constants/departments.ts`・`GovernancePage.tsx`・ai-engine も同じ5値を使用。**`'SNS'` はコードのどこにも存在しない**（SNS/マーケ部署は `MARKETING`）。`ACCOUNTING`（経理部）が契約から欠落。
- 理由: 部署別KPI（本ANALYTICS部署の中核）・営業/マーケ各部署の所有境界・DBの department 文字列すべてがこの値域に依存する。契約の `SNS` を信じて実装すると、実データ（MARKETING）と一致せず集計・フィルタが空になる。
- 提案: 共有コントラクト v0 の値域を実正本 `SALES | MARKETING | ACCOUNTING | ANALYTICS | GENERAL` に統一。SNS投稿部署の成果物は `department = 'MARKETING'` にマッピング（`SnsPage` 等のUI名はそのままで可、データ次元だけ MARKETING に寄せる）。
- 暫定対応: 本ANALYTICS部署は実正本の5値（`AGENT_DEPARTMENTS`）に従って A-2 を実装済み。契約側の文言修正は統合Bにて。
- ステータス: 未対応
