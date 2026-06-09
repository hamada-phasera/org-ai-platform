# 作業ログ — org-ai-platform 最適化 + n8nエージェント機能

ブランチ: `feat/agent-create-n8n`（`feat/n8n-per-department` から分岐）
計画: `~/.claude/plans/org-ai-platform-n-n-n-n-happy-harp.md`

方針（ユーザー確認済み）:
- エージェント方式 = ハイブリッド（DB が真実の源 + n8n 専用ワークフロー best-effort 生成 + AI Engine フォールバック）
- n8n 稼働 = 無料 + 優雅な縮退（リトライ / 「n8n起動中…」可視化 / 平日日中 keepalive）
- デプロイ = Vercel プレビューのみ（本番 `flow` は上書きしない）

---

## 2026-06-10

### Phase 0: 調査（Explore × 3 + Plan agent）
- UI: 孤児 `DashboardPage.tsx`、死んだ Bell ボタン、重複 `GlassCard`、未使用 `GlassNav`/`GlassPanel`、`/governance` がメインナビ未掲載、エージェントはハードコード静的リスト。
- バックエンド: `Capability` 系は実装済みだが `Agent` モデル・作成/再選択/再実行・動的 n8n ワークフロー生成が無い。
- インフラ: Render 無料枠 n8n は ~15分でスリープ、無料枠 750h/月制約で3サービス常時稼働不可、keepalive 無し。`CLAUDE.md`/`.env` の Groq 記述は陳腐化（実体は Anthropic）。

### Phase 1: Prisma `Agent` モデル + マイグレーション ✅
- `packages/db-schema/prisma/schema.prisma`: `enum AgentN8nStatus`/`AgentTrigger`、`model Agent`、`Organization.agents`、`Task.agentId`(+optional relation, `Task_orgId_agentId_idx`) を追加。
- マイグレーション `migrations/20260610000000_add_agent/migration.sql` を手書き（docker 不在のため。既存マイグレーションの SQL 規約に準拠。`Task.agentId` は `ON DELETE SET NULL` で削除時に履歴保持）。
- `prisma format`/`validate`（DATABASE_URL 由来の env エラーのみ＝スキーマ自体は正常）/`generate` 成功。`Agent`/`AgentN8nStatus` 型生成を確認。

### Phase 2: バックエンド（gateway） ✅
- `services/n8n-workflow-builder.ts`（新規）: `buildAgentWorkflowJson` でエージェント用ワークフロー(Webhook→Log→Build Prompt→AI Engine→Callback)をコード生成。instructions は `JSON.stringify` で安全に埋め込み、webhook body の `systemPrompt` を優先。`createAgentWorkflow`/`syncAgentWorkflow`/`deleteAgentWorkflow` を Public API + timeout 付き fetch で実装（n8n 不達でも throw → PENDING）。
- `services/task-executor.ts`: `triggerN8nWorkflowByPath`（path 明示 + systemPrompt 送出）、`isWebhookAvailableByName`、`executeTaskViaAgentEngine`（/llm/chat に instructions 注入）、`dispatchAgentTask`（webhook を 0/5/15s リトライ＋「n8n起動中…」TaskLog→フォールバック）を追加。
- `routes/agents.ts`: 既存 `/stats` に加え GET 一覧/単体、POST 作成（任意 AI 推論 + n8n 生成）、POST `:id/run`、PATCH、DELETE を追加。
- `npm run build`（gateway tsc）パス。

### Phase 3: AI-Engine ✅
- `/plan/agent`（opt-in）: 自由記述 → name/department/instructions/steps/trigger を推論。`plan_agent` + 専用プロンプト。PII screen + audit log は `/plan` と同様。`py_compile` パス。

### Phase 4: フロントエンド + UIクリーンアップ ✅
- `types/agent.ts`: `SavedAgent` 型 + `AGENT_N8N_STATUS_LABEL`。
- `pages/AgentsPage.tsx`（/agents, ルート追加）: react-query で一覧 → 選択 → 実行/削除/作成。
- `components/Agents/CreateAgentModal.tsx`（手入力 + AI提案）、`AgentRunModal.tsx`（実行 + WS task ストリーム、「n8n起動中…」可視化）。
- `BottomNav`: 死んだ Bell ボタンを削除し `/agents`(Bot) と `/governance`(Shield) の NavItem を追加。
- クリーンアップ削除: 孤児 `pages/DashboardPage.tsx`、未使用 `ui/GlassNav.tsx`/`ui/GlassPanel.tsx`、重複 `taskmanager/.../ui/GlassCard.tsx`（`ProjectResultsPanel` を正準 GlassCard に移行）、孤児 `SetupChecklistBanner.tsx`。`ui/index.ts` の該当 export 除去。
- `ChatPage`: streaming fetch のベース URL を `api.defaults.baseURL` に一本化（VITE_API_URL 重複解消）。
- `vite build`（Vercel ビルドコマンド）パス。注: 既存の `tsc --noEmit` エラー（import.meta.env/recharts lodash/dexie 等）は本変更前から存在、デプロイ経路の vite build は正常。

### Phase 5: 信頼性（keepalive）✅
- `.github/workflows/keepalive.yml`: 平日 JST 9-19 のみ ~12分間隔で gateway/ai-engine/n8n の health を ping（月 ~220h/サービス、750h 枠内）。Vercel Cron は Hobby が「1日1回・本番のみ」かつ SPA に関数が無いため不採用。コールドスタート UX はバックエンド（リトライ+TaskLog）と AgentRunModal で実装済み。

### Phase 6: ドキュメント整備 ✅
- `CLAUDE.md`: スタック表 Groq→Anthropic / SQLite→PostgreSQL、env ブロック更新、エージェント機能 / n8n 稼働・有料化導線セクション追加。
- `.env.example`: 調査時点で既に Anthropic 準拠（`GROQ_API_KEY` 不在）かつ権限の Read deny 対象のため変更なし。

### 既知の制約 / メモ
- ガバナンス統計 UI（旧 DashboardPage の棒グラフ）は移植せず破棄。`/api/agents/stats` エンドポイントは残置（将来 GovernancePage へ移植可能）。
- vercel-plugin の posttooluse バリデータが n8n の "workflow" 命名や Node の setTimeout/fetch を Vercel Workflow DevKit と誤検出するが、本コードは n8n REST + Fastify/Node 実行であり全て false positive。意図的に無視。
