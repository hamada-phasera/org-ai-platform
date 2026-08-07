# FLOW 意味の説明書 第1版（semantic layer v1）

> 用途: LLM がクエリ生成・スキル選択・検証を行うときに、この文書を**そのまま文脈に入れる**。
> 対象業務: 見積もり・提案書作成（営業）。他部署は第2版以降で拡張。
> 正本: このファイル。変更は PR レビュー（人承認）＋版管理を必須とする。自己改善ループはこの文書を書き換えない。
> 根拠スキーマ: `packages/db-schema/prisma/schema.prisma`（2026-08-06 時点・アプリ 18 モデル）

## 大原則（すべてのクエリ・スキルに適用）

1. **テナント分離**: すべての読み書きは必ず `orgId = <現在の組織>` で絞る。orgId 条件の無いクエリは生成禁止。
2. **金額は整数**: 金額カラムは円単位の整数（`Int`）。小数・浮動小数点で計算しない。
3. **集計は SQL/コードで**: 合計・構成比・前年比などの派生値は LLM が暗算せず、クエリ側で算出して事実として渡す。
4. **無いものは無いと言う**: 下記 GAP に挙げた概念はまだ DB に存在しない。それらしい値を推測で埋めない。

## 概念 → DB 対応表

| # | 業務概念 | 定義 | DB 上の実体 | 主要フィールド | 状態 |
|---|---|---|---|---|---|
| 1 | 組織（テナント） | FLOW を契約する 1 社 | `Organization` | `id` `name` `plan`(STARTER/PRO/MAX) `billingEmail` | ✅ |
| 2 | 利用者 | 組織に属する人 | `User` | `id` `orgId` `email` `role`(OWNER/MEMBER) | ✅ |
| 3 | 商談 | 受注を目指す案件。営業パイプラインの単位 | `Deal` | `id` `orgId` `title` `company` `amount`(円) `stage` `ownerId` | ✅ |
| 4 | 商談ステージ | 商談の進行状態 | `Deal.stage`（文字列） | `LEAD`(見込み)→`NEGOTIATION`(交渉)→`PROPOSAL`(提案)→`WON`(受注)。遷移規則は `pipeline-core.ts: canTransition` | ✅ |
| 5 | 顧客 | 商談の相手企業 | **専用テーブル無し**。`Deal.company`（自由入力文字列）のみ | — | ⚠️ GAP-1 |
| 6 | 提案書 | 商談に添える提案文書。**現行は金額を書かない**（テンプレの指示で「価格は要お見積り」と明記） | `Task`（`taskType='proposal'`, `status='DONE'`, 本文は `output`） | `Task.output`(テキスト) `Task.agentId` `Task.department='SALES'` | ✅（文書のみ） |
| 7 | 見積もり | 金額の入った正式な見積 | **存在しない** | — | ❌ GAP-2 |
| 8 | 見積もり明細 | 品目×数量×単価の行 | **存在しない** | — | ❌ GAP-3 |
| 9 | 単価表 | 品目ごとの標準単価マスタ | **存在しない** | — | ❌ GAP-4 |
| 10 | 実行タスク | AI/エージェントに依頼した 1 仕事 | `Task` + `TaskLog` | `status`(QUEUED/RUNNING/DONE/FAILED…) `input` `output` `taskType` `agentId` | ✅ |
| 11 | 保存エージェント | 再利用可能な業務手順の定義 | `Agent` | `instructions` `department` `steps`(JSON) `n8nStatus` | ✅ |
| 12 | 過去のやり取り・資料 | 検索可能な知識（RAG） | `Message`/`FileChunk`/`MessageEmbedding`（vector 1024・コサイン） | 類似しきい値 0.3、添付指定は無条件注入 | ✅ |
| 13 | 外部連携操作 | n8n で実行する外部 SaaS 操作 | `Capability` + `RequiredCredential` + `ExecutionLog` | `name` `argsSchema`(Ajv) `status` | ✅ |
| 14 | 監査記録 | すべての AI 入出力の記録 | `AILog`（+ PII 検出時 `RiskEvent`） | `provider` `model` `inputText`(原文) `riskScore` | ✅ |

## 語彙の言い換え辞書（テナント別・第1版は既定のみ）

| 中核概念 | 既定 | 建設業 | 物流業 |
|---|---|---|---|
| Deal | 商談 | **工事** / 現場 | **案件** / 荷主案件 |
| Deal.company | 相手企業 | 施主 / 元請 | 荷主 |
| 提案書 | 提案書 | 見積提案 | 提案資料 |

> ルール: ユーザー発話の語をこの表で中核概念に正規化してから概念で考える。逆方向（出力時）はテナントの語で書く。

## 曖昧さの裁き方

- 「売上」→ `Deal.stage='WON'` の `amount` 合計（受注ベース）。請求・入金テーブルは無いので「入金ベースの売上」は**回答不能**と答える。
- 「今月」→ JST で月初〜現在。DB は UTC 保存なので変換して比較する。
- 「見積もりを作って」→ GAP-2 のため正式見積は作れない。現行できるのは**提案書（金額なし）**。金額入り見積の依頼には「単価表と明細の仕組みが未導入」と明示して提案書生成を代替提示する。
- 「顧客一覧」→ `SELECT DISTINCT company FROM Deal WHERE orgId=…`（GAP-1 のため商談由来の近似）。

## スキル型づけ（スキル台帳に載せる4項目の書式）

各スキルは次の4項目で宣言する。計画の検証はこの型チェックで機械的に行う。

```
skill: fetch_deals
  対象概念: 商談(Deal)
  入力型: { orgId: ID!, period?: Month, stage?: Stage }
  前提: なし
  効果: 読み取りのみ（副作用なし）

skill: compose_proposal
  対象概念: 提案書(Task[type=proposal])
  入力型: { orgId: ID!, dealId: ID!, templateId?: string }
  前提: Deal が存在し stage >= NEGOTIATION
  効果: Task を1件作成（外部送信なし）

skill: verify_amounts        ← 機械的検算。金額を扱う出力は必ずこれを通す
  対象概念: 見積もり明細（GAP-3 導入後）
  入力型: { lines: {qty:Int, unitPrice:Int}[], total: Int }
  前提: なし
  効果: 読み取りのみ。単価×数量の再計算と合計一致を判定
```

## GAP（見積もり業務を成立させるために必要な追加）

| ID | 追加するもの | 最小スキーマ案 | 優先 |
|---|---|---|---|
| GAP-1 | 顧客マスタ | `Customer(id, orgId, name, contact?)` + `Deal.customerId?` | 中 |
| GAP-2 | 見積もり | `Quote(id, orgId, dealId, status[DRAFT/SENT/ACCEPTED], total, createdBy)` | **高** |
| GAP-3 | 見積もり明細 | `QuoteLine(id, quoteId, item, qty, unitPrice, subtotal)` | **高** |
| GAP-4 | 単価表 | `PriceBookItem(id, orgId, item, unitPrice, unit, note?)` | **高** |

> GAP-2〜4 が入るまで、「見積もり作成」ハーネスの計画テンプレ（案件参照→過去見積検索→単価表→計算→検査）は**組めない**。
> 8月検証で金額入り見積を課題にするなら、このマイグレーションが先行条件。
