# 統合レビュー 2026-07-08（サイクル1 / B本番）

3部署（営業/分析/SNS）の R1+R2 を `feat/integration` に統合し、配線・ビルド・テストまで検証した結果。

## 統合サマリ
- マージ済み: feat/analytics-dept（FF）→ feat/sales-dept（-X ours, docsのみ衝突）→ feat/sns-dept（同）。**コードは各部署 disjoint で衝突ゼロ**、docs 衝突は統合側を保持し本レビュー/ボードで正本化。
- 配線(I-0): `App.tsx` に `/sales /analytics /sns`、`api-gateway/index.ts` に `salesPipelineRoutes(/api/sales/pipeline)`・`salesProposalsRoutes(/api/sales/proposals)`・`snsPostsRoutes(/api/sns/posts)`・`analyticsRoutes(/api/analytics)`。
- 検証: web `vite build` ✅(2831 modules) / api-gateway `tsc --noCheck` ✅ / api tests **95/96 pass** / usage-metrics-svc `go test ./...` ✅ 全green。

## 🔴 マージブロッカー
- **なし。** 全コード統合済・ビルド通過・dept テスト全pass。feat/integration は main へ取り込み可能な状態。

## 🟡 マージ後対応（要フォロー / 一部は要人間判断）
1. **既存の失敗テスト** `agentWebhookPath('x') → 'agent-x'`（`routes/agents.ts`）。**Bの回帰ではない**（agents.ts は base c83ee65 と完全一致＝統合前から赤）。別途修正すべき既存債務。
2. **prisma スキーマ変更（要確認・要 migration）**:
   - `Deal` モデル（営業#1。現状 pipeline はインメモリMap mock）
   - `Task.scheduledAt DateTime?` + index（SNS#S4。現状 output JSON に格納）
   - `Task.status` に `PENDING_APPROVAL/APPROVED/REJECTED`（SNS#S2。現状 文字列で運用）
   → スキーマ変更は不可逆寄りなので**人間承認 + migration 作成**を別ステップで。
3. **taskType 予約の確定**: `proposal`(営業) / `sns`(SNS)。分析KPI集計（taskType 別）と衝突しないことを確認済みだが正式予約は要合意。
4. **コスト単価**: 分析は `usage-metrics-svc/internal/domain/pricing.go` の DefaultPricing（haiku 3 / sonnet 9 / opus 15 / fallback 9 USD/MTok）を使用。**実 Anthropic レートの確認**が必要（捏造なし・placeholder 明示済み）。
5. **コンプラ#5 の後始末**: `/llm/chat` 中央ロギングは統合済。営業 `proposals.ts` の best-effort `prisma.aILog.create` は**重複になるので撤去候補**。
6. **ナビ IX（phase-2）**: 3ページは URL 到達可だが `BottomNav` 未掲載（既に5+AIで満杯、8個超はモバイルで破綻）。部署ナビの設計（サブメニュー等）は phase-2 判断。

## 🟢 shared 昇格候補（現状は各部署のローカルモック → `packages/shared-types` へ集約）
- `PipelineStage` / `Deal`（営業 pipeline.ts）
- `ProposalTemplate` / `ProposalSection`（営業 proposal-templates.ts）
- `KpiEvent`(discriminated union) / `DepartmentKpi`（分析 kpiEvents.ts）
- `TaskStatus`（PENDING_APPROVAL/APPROVED/REJECTED を含む拡張。SNS）
- department 値域は既に `AgentDepartment`（SALES|MARKETING|ACCOUNTING|ANALYTICS|GENERAL）で正本化済み。

## integration-requests 消化状況
- ✅ 解決: 営業#3/分析#2（vocab=MARKETING 確定）、営業#5/SNS#S3（/llm/chat 中央ロギング統合）、営業#2/SNS#S2配線/分析#A3（配線実施）。
- ⏳ 残（上記🟡へ）: 営業#1(Deal+prisma)、営業#4(ProposalTemplate+taskType)、分析#1(KPI型+単価)、SNS#S1(vocab/taskType=解決見込)、SNS#S4(scheduledAt)。
- 注: dept ブランチの採番が衝突（#1,#2 が複数部署で重複）。上記の通り部署接頭辞で識別。

## マージ順序の推奨
1. `feat/integration` は**1単位として** `main` に取り込む（既に3部署統合済・検証済のため分割不要）。ローカル `main` を FF。
2. `deploy-prod`（本番デプロイ枝）への反映は**別のデプロイ判断**。#2決定（ローカルB統合のみ・origin へ push しない）に従い、GitHub PR / Vercel/Render デプロイは後日あなたが実施。
3. 🟡#2（prisma migration）は main 取り込みとは独立に、承認後の専用ステップで。
