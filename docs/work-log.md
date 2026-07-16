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

### Phase 7: テスト + デプロイ + 検証 ✅
- `vitest run`（gateway）: 3 ファイル 10 件パス（既存 capability-resolver + 新規 builder/dispatch）。
- Vercel **プレビュー**デプロイ（project `flow`、`org-ai-platform` から、`--prod` なし＝本番ドメイン非更新）: READY。
  - URL: https://flow-n5a6ybcec-hamahiro1668s-projects.vercel.app （Vercel Deployment Protection(SSO) 有効＝チーム限定。匿名は 401。チームメンバーはブラウザで閲覧可）。
- ローカル ブラウザ検証（vite dev + agent-browser）:
  - `/` → `/login` リダイレクト（RequireAuth 動作）、ログイン画面描画 OK、ランタイムクラッシュ無し。
  - `/agents`（未認証）→ `/login` リダイレクト（ルート登録＆ガード確認）。
  - トークン注入後 `/agents` → ページ描画（ヘッダ「業務効率化エージェント」＋「エージェントを作成」＋新ナビ）。バックエンド未起動のため「読み込みに失敗しました」EmptyState（想定通り、クラッシュ無し）。
  - 「エージェントを作成」→ CreateAgentModal 描画（AI提案チェック/名前/説明/部署/指示/作成ボタン disabled バリデーション）。

### 残作業（このタスク範囲外・要承認）
- **エンドツーエンドの agent 作成/実行**には Render のバックエンド再デプロイ＋マイグレーション適用が必要:
  - gateway/ai-engine を本ブランチのコードで再デプロイ（Render は接続ブランチに push で自動デプロイ。`git push` は権限上 ask）。
  - 起動時 `prisma migrate deploy` で `20260610000000_add_agent` を Neon に適用。
  - n8n を使う場合は `N8N_API_KEY` を gateway env に設定（専用ワークフロー生成に必要）。未設定でも AI Engine フォールバックで動作。
- 本タスクでは Vercel プレビュー（フロント）までを実施。フロントは描画検証済み、バックエンドは tsc/py_compile/unit テストで検証済み。

### Phase 8: 本番デプロイ完遂 + 実行検証（2回目のセッション）✅
判明した詰まりと解決:
- **2リポ構成**: ローカル origin = `hamada-phasera/org-ai-platform`、だが **Render は `hamahiro1668/org-ai-platform` の `main` をデプロイ**。コードを後者の main に fast-forward push して反映（keepalive.yml は workflow スコープ不足で除外）。
- **ビルド失敗の連鎖を解決**: ①`shared-types` TS5011 → `rootDir` 明示。②gateway が Render で `@types/node` を解決できず src が `process` 等で失敗（ローカルでは再現せず、6f67052 と同一 tsconfig）。`skipLibCheck` + 最終的に **build を `tsc --noCheck`（トランスパイルのみ）に変更、型検査は `typecheck` スクリプト/CI で担保**。③Render の stale main cache（6f67052）対策で commitId 明示デプロイ。
- **429/500 の真因 = `ANTHROPIC_API_KEY` 未設定**（両サービスに旧 `GROQ_API_KEY` のみ）。ユーザー提供のキーを Render API で両サービスに設定 → `/ready.anthropic=true`。
- **CORS**: `FRONTEND_URL='*'` が `['*']` 完全一致で全オリジンを弾いていた → origin 関数で `*.vercel.app` + localhost を許可（プレビューURLのローテーション対応）。
- **本番E2E検証成功**: register → エージェント作成「競合比較」→ 一覧（再選択）→ 実行 → **Claude 実出力**で `DONE`。CORS プリフライト 204 + allow-origin 反映を確認。

最終状態（本番）:
- フロント: Vercel プレビュー（`flow-n5a6ybcec…`）。バック: Render `org-ai-api-gateway`/`org-ai-ai-engine` が `hamahiro1668/main`（CORS修正コミット `f81c82f`）で稼働。Neon に `Agent` テーブル適用済み。Anthropic キー設定済み。
- リポジトリ: 正準デプロイ元 = `hamahiro1668/main`（全修正反映）。作業リポ `hamada-phasera` には feature ブランチ + `deploy-prod` ブランチ（最終状態）を保持。

### Phase 9: n8n ワークフロー生成・n8n経由実行を有効化 ✅（2回目セッション後半）
ユーザー提供の Render API キー / Anthropic キー / n8n API キーで本番設定し、n8n 経由のエージェント実行を**完全動作**させた。
- **n8n 調査**: active な n8n = `org-ai-n8n-web.onrender.com`（v2.15, Neon DB, Public API 有効）。gateway に `N8N_API_KEY` が無かったため設定（→ 生成有効化）。
- **n8n ワークフロー生成 ✅**: エージェント作成時に `org-ai Agent <id>` が生成・active 化されることを Public API で確認（`n8nStatus=ACTIVE`）。
- **n8n 経由実行の詰まりを実行ログで1つずつ特定・修正**:
  1. **WAF（Render edge）が Code ノード入り作成を「Blocked」403** → Code ノード廃止、LLM本文は gateway で組み立て `llmBody`（JSON文字列）を webhook 経由で渡す設計に（`buildAgentWorkflowJson` 全面改修 + `triggerN8nWorkflowByPath` で llmBody 構築）。
  2. **n8n が式内 `$env` をブロック**（"access to env vars denied"）でコールバック失敗 → トークンを生成時に literal 埋め込み。
  3. **コールバック先が `localhost:4000`**（gateway に `API_GATEWAY_URL` 未設定）で connection refused → Render env に `API_GATEWAY_URL=https://org-ai-api-gateway.onrender.com` 設定。
  4. **コールバックノードが GET 送信**（n8n httpRequest は method 既定 GET）で POST専用ルートに 404 → コールバックノードに `method: 'POST'` 追加。
- **本番E2E成功 ✅**: register→作成（n8nStatus=ACTIVE）→実行→ **Webhook → AI Engine Chat → Callback(POST) → task DONE**（実Claude出力）。n8n executions API で `status=success` を確認。
- n8n がスリープ中は gateway の retry→AI Engineフォールバックで実行（DBが真実の源のため必ず完走）。

### Phase 10: n8n常時稼働 + 効率化ダッシュボード + UIクリーン刷新（ユーザー確認: 有料$7 / タスク種別プリセット / クリーン&プロフェッショナル）
- **n8n常時稼働**: `org-ai-n8n-web` を Render Starter にしようとしたが API が `Plan requires payment information on file` で 400。→ Render に支払い方法登録後に `serviceDetails.plan=starter` を PATCH（ユーザー操作待ち）。
- **効率化ダッシュボードBE**: `GET /api/dashboard/efficiency`（`routes/dashboard.ts`）。タスク種別プリセット(分)で完了タスクを集計→今日/今週/累計 + 7日トレンド + 部署別、1日25%(=120分/8h)目標。JST日境界。本番デプロイ済み・E2E確認（agent実行1件→today 30分/25%）。
- **UIクリーン刷新（light/dark）**: `tailwind.config.js`/`index.css` をCSS変数駆動に（ニュートラルslate + indigo accent、flat surface、glass-*/liquid-* をフラット化、虹排除、radius縮小）。`AmbientBackground` を微アクセントグロー+グリッドに。`themeStore` + ナビにダークトグル、`main.tsx` で先行適用(既定light)。`HomePage`(新ホーム=効率化ダッシュボード) を `/` に。`BottomNav` 刷新(indigo/ニュートラル/トグル、キャラ画像撤去)、`GlassButton` primary を単色accentに。`DashboardLayout`(旧カルーセル)は不使用化。
- 検証: `vite build` 通過、agent-browser でライト/ダーク両方の見た目確認、Vercelプレビュー `flow-43g1hbj3n` デプロイ、ダッシュボードAPI本番反映(404→401)。

### 既知の制約 / メモ
- gateway の Render ビルドは `tsc --noCheck`（環境固有の @types/node 解決問題回避）。型安全は `npm run typecheck` と vitest で担保。根本原因（Render の monorepo hoisting）が解決すれば `tsc` に戻してよい。
- keepalive.yml は workflow スコープの都合で `hamahiro1668` 側 main に未反映。GitHub UI から追加するか、scope 付きトークンで push 可能。
- n8n 専用ワークフロー生成を使うには gateway env に `N8N_API_KEY` が必要（現状未設定→ agent は AI Engine フォールバックで実行＝動作する）。
- ガバナンス統計 UI（旧 DashboardPage の棒グラフ）は移植せず破棄。`/api/agents/stats` エンドポイントは残置（将来 GovernancePage へ移植可能）。
- vercel-plugin の posttooluse バリデータが n8n の "workflow" 命名や Node の setTimeout/fetch を Vercel Workflow DevKit と誤検出するが、本コードは n8n REST + Fastify/Node 実行であり全て false positive。意図的に無視。

---

## 2026-06-22 — チャット起点の成果物生成 + RAG + 外部連携（ブランチ `deploy-prod`）

計画通り 3 フェーズを実装。整合性チェック（並列5エージェント + ライブ n8n WAF プローブ）で計画の前提を検証してから着手。

### Phase C: エージェント化 CTA ✅（commit d230d2d）
- ai-engine: ストリーム経路を `_build_system_prompt` 経由に変更（SECURITY_CORE + `AGENTIZATION_HINT` + `<user_query>` ラップを付与＝従来ストリームが SECURITY_CORE を飛ばしていた問題も解消）。
- gateway: `POST /chat/sessions/:id/suggest` を新設。既存 `/plan/agent` を会話全体に再利用し、ユーザー発話2往復以上＋confidence>=0.6 のときだけエージェント草案を返す（失敗時は常に suggest:false でチャットを阻害しない）。
- web: 会話が定型業務に育つと assistant メッセージ下に `AgentCtaCard`。`CreateAgentModal` を草案（名前/指示/部署）でプリフィル（`initialName`/`initialInstructions`/`initialDepartment` を追加、毎回フレッシュにマウント）。「あとで」でセッション中は抑制。

### Phase A: RAG（pgvector + 埋め込み）✅（commit a34d3f9）
- DB: マイグレーション `20260622000000_add_pgvector_rag`（`CREATE EXTENSION vector` + `FileChunk`/`MessageEmbedding`(vector(1024)) + FK + HNSW cosine index）。Neon は pgvector 0.8.0 提供を確認。schema は `Unsupported("vector(1024)")`、読み書きは `$queryRaw`/`$executeRaw`。
- gateway: `services/embeddings.ts`（Voyage 既定 / OpenAI 代替・1024次元固定・`EMBEDDING_API_KEY` 未設定なら no-op）、`services/rag.ts`（chunk/indexFile/indexMessage/retrieveContext＝org スコープのコサイン類似 + 上位K + 文字予算 + 出典ラベル）。`fileExtractor` に `maxChars` 追加（索引は全文）。`files.ts` でアップロード時に索引（fire-and-forget）。`chat.ts` ストリーム/非ストリーム両方で関連根拠を取得し `context` として ai-engine に渡し、応答後に当該往復を索引。`pdf-parse@1.1.1`(pin)/`mammoth` を依存追加。
- ai-engine: `OrchestateRequest.context`、`GROUNDING_INSTRUCTION`（資料に基づき回答・無い事は「記載なし」・出典明記）を両経路で注入。
- **要・本番有効化**: `EMBEDDING_API_KEY`（Voyage 推奨）を gateway Render env に設定するまで RAG は休眠（チャットは従来通り）。

### Phase B: Google/Slack 成果物 capability ✅（commit 7acc818）
- seed-capabilities: `create_google_doc`/`create_google_sheet`/`create_google_slides` を追加（provider は `googledocs`/`googlesheets`/`googleslides`＝n8n credential **type** に substring 一致させ resolver の接続判定を通す）。`notify_slack` を成果物投稿向けに拡張。
- n8n: `cap-create_google_{doc,sheet,slides}.json` + `cap-notify_slack.json`。WAF 安全形（Webhook headerAuth/responseNode → provider ノード → respondToWebhook の式でエンベロープ生成・Code ノード無し）。
- web: 入力欄上に `DeliverableBar`（ドキュメント/スプレッドシート/スライド/Slack）。`createDeliverable()` が直近の AI 回答を `POST /api/capabilities/resolve` に送り（resolver が cap+引数を推論実行）、URL かNEEDS_AUTH 案内をインラインメッセージ表示。
- `docs/oauth-setup.md`: Google Cloud + Slack app + n8n クレデンシャル接続 + 取込 + 検証の手順。
- **要・本番有効化**: `docs/oauth-setup.md` に沿って n8n に Google/Slack OAuth を接続するまで各 capability は NEEDS_AUTH（チャットでは接続案内を表示）。ノードのパラメータはテンプレ＝接続後にエディタで一度確認推奨。

### デプロイ準備
- 検証: ai-engine `py_compile`、gateway `tsc --noEmit`、`prisma validate`、`vite build`、cap JSON parse すべて通過。
- `render.yaml`: gateway は `npm install`（ci ではない）＝新依存は自動解決。`startCommand` に `prisma migrate deploy` あり＝pgvector マイグレーションは次回デプロイで自動適用（Neon の role は拡張作成可）。
- **未実施（要・明示承認）**: `hamahiro1668/main` への push → Render 自動デプロイ（migrate + 依存 install）、Vercel フロント本番デプロイ、gateway env に `EMBEDDING_API_KEY` 追加。

### 2026-06-24 本番反映＆検証 + Voyage レート制限対応
- `hamahiro1668/main` へ push → Render 自動デプロイ（pgvector マイグレ適用・pgvector 0.8.0）、Vercel 本番反映。
- 本番E2E検証済み: エージェント化CTA / 成果物ヒアリング(提案書) / RAGファイル根拠(出典付き正答＋off-topicは「記載なし」) / 横断ファイル参照 / **過去チャット横断参照**（要望③）。
- 追加修正: 添付ファイルは類似度無視で必ず注入(e128085)、横断検索しきい値0.3(1ca35f6)、**埋め込み429/5xxリトライ(16f4895)**、**user/assistantを1回の埋め込みにまとめてRPM半減(1750599)**。
- **Voyage 無料/トライアル枠は RPM が低く、連続テストで埋め込みが429→null→索引行が作られず/根拠注入されず RAG が静かに無効化される**罠を確認・対処。検索SQL/HNSW/コサインは正常（別セッションのメッセージをスコア0.62で返却）。持続負荷では Voyage 有料枠推奨。
- 成果物(Google/Slack)は OAuth 未接続のため NEEDS_AUTH（`docs/oauth-setup.md`）。

### 2026-06-24 成果物の重要度ランキング + 共有
- 成果物（完了タスク）を **AIがビジネス重要度で high/mid/low に自動分類**（ai-engine `POST /rank` → gateway `POST /api/deliverables/rank`、json_mode）。クライアントにキャッシュ＋手動上書き（カードのバッジをクリックで高→中→低→AI値）。
- `/deliverables` を **重要度順に自動ソート**、ヘッダーに「AIで重要度を再評価」「重要度順で共有」。共有＝重要度でグルーピングしたMarkdownリスト（出典リンク付き）をクリップボード＋`navigator.share`。
- 本番E2E検証: 提案書=高 / 経費集計=中 / ランチ会案内=低 と妥当に分類（commit b3ba30d、Render+Vercel反映）。DB変更なし（重要度はクライアント保持）。

### 2026-06-24 チェーン型エージェント（steps→実n8nノード）Doc先行
- エージェントの `steps` を実 provider ノードへ展開する `buildChainedAgentWorkflowJson` を実装（`create_google_doc` 対応）。`create_google_doc` ステップ＋Google Docs OAuth接続済みなら、Webhook→AI Plan(/llm/chat)→Parse Args(Code, fence耐性)→Create Doc(folderId=root)→Insert Content→Callback の多段WFを生成・有効化。未対応/未接続は従来の軽量シェルにフォールバック（後方互換）。
- ディスパッチャ: チェーン型は「{title,content}をJSONで出力」プロンプトの llmBody を組む（json_mode=false→Sonnet本文）。`agent.steps` を create/run 経路に流す。
- 全httpRequest/Docノードに node-level retry（一時503/429/コールドスタート対策。最初のE2Eで AI Plan が ai-engine 再デプロイ中の503で停止→QUEUED滞留したため追加）。
- **本番E2E成功**: doc-stepエージェント作成→チェーン型WF生成(ACTIVE)→/run→タスクDONE→`{docUrl, title}`（実Googleドキュメント生成）。commit b3482e7。
- 残: Sheet/Slidesステップのノード展開、CreateAgentModalでのsteps可視化/編集。

## 2026-07-07〜08 — 3画面マルチエージェント体制でサイクル1完遂 + 松竹梅LLMルーティング

### 重要度順サマリ（週次メモ）
1. **3部署バーティカル（営業/分析/SNS）完成・統合・E2E合格** — オーガナイザー+ワーカーの3画面体制で並列開発。営業(SalesPage+商談パイプラインAPI+提案書生成)、分析(KPIスキーマ+AnalyticsPage+usage-metrics-svc部署別集計 /metrics/departments)、SNS(SnsPage+下書き生成IG/X/LinkedIn+承認キュー+カレンダー)。B統合で配線(App.tsx 3ルート/index.ts 4登録)→docker実DBでフルE2E合格（商談作成/遷移・下書き→承認APPROVED・部署別コスト/レイテンシKPI集計）。テスト: vitest 95/96(1件は既存agents債務)+Go全green。
2. **松竹梅LLMプロバイダルーティング（コスト構造の根幹）** — 梅(STARTER)/竹(PRO)=Gemini無料枠(flash-lite/flash)、松(MAX)/admin(ADMIN_EMAILS)=Claude、エージェント構築(/plan/agent)は全ユーザーOpus固定。GeminiProvider新規(httpx REST・依存追加ゼロ・SSE対応)。LLMRouter一点分岐で全経路適用＝**n8nも変更ゼロで自動適用**。JWTにemailクレーム追加→user_email貫通。キー未設定はClaude安全フォールバック。実キーでlive検証済み(flash-lite応答確認)。ルーティング行列9ケース全PASS。→ docs/llm-provider-tiers.md。commit e4117fd。
3. **リポジトリ正準化: hamada-phasera/main に集約** — mainが3系統に分裂（作業=hamada-phasera/デプロイ=hamahiro1668 fork/ローカル統合）していたのを解消。fork差分0確認の上、cycle-1統合+Phase8-10全部入りをクリーンFFでhamada-phasera/mainへ(2782bc3→e4117fd)。連携張り替え手順書=docs/hamada-phasera-canonical.md。
4. **コンプライアンス修正: /llm/chat のAILog中央ロギング** — /llm/chatがlog_llm_call未発火で直呼び経路(gateway /api/llm/chat・部署生成機能)が監査ログから漏れていた（営業ワーカーが検出）。/plan同様の集中ロギングに修正(riskScore/RiskEvent込み)。AILog.providerは実プロバイダ(gemini/anthropic)を記録するよう更新。
5. **n8n統合設計（D1/D2確定）** — 3軸モデル（生成系=Task/dispatch化・副作用系=承認ゲート後のみ・監視系=cron読み取り）。D1: 生成系(提案/SNS下書き)をdispatchQueuedTaskへ寄せる（次フェーズ実装）。D2: SNSは段階1=投稿準備まで(実投稿はSNS_LIVE_POST明示解放のみ)。→ docs/n8n-integration-design.md。
6. **開発体制の資産化** — docs/tasks.md進捗ボード+共有コントラクト(所有vs配線分離)+integration-requests運用で境界違反ゼロのまま3部署並列を完走。department語彙修正(SNS→MARKETING、契約バグを両部署が独立検出)。usage-metrics-svc(Go 29ファイル)を孤児ブランチからmainへ統合。worktreeをorg-ai-platform/.worktrees/配下に整理。
7. **デプロイ準備** — docs/DEPLOY.md(手順書)。残ブロッカー: Render(支払い復旧済)のRepo張り替え(→hamada-phasera)+ai-engineへGEMINI_API_KEY/ADMIN_EMAILS設定+デプロイ実行はダッシュボード操作待ち。ローカル環境はNeon:5432到達不可等ネット制約あり(安定回線で実施)。

### 残タスク（次スプリント候補）
- Render/Vercelの連携張り替え→本番デプロイ→スモーク（DEPLOY.md/hamada-phasera-canonical.md）
- shared-types昇格+prisma migration（Deal/scheduledAt/TaskStatus拡張）→ integration-review.md 🟡
- n8n D1実装（生成系Task化）+SNS段階1（投稿準備cron）+分析KPIアラート
- pricing.goにgemini=0円扱い追加（コスト集計）/ 既存agents失敗テスト1件の修繕

## 2026-07-16 — 次スプリント残タスク消化（shared-types 昇格 / n8n D1 / SNS段階1 / KPIアラート / pricing）

ブランチ: `claude/repository-status-catchup-33dy6x`（`main` 2782bc3→062bf2a 起点）。
integration-review.md 🟡 と n8n-integration-design.md D1/D2 の残タスクを実装。

### 1. shared-types 昇格 + Prisma マイグレーション ✅（🟡#2・営業#1/#4・分析#1・SNS#S4 消化）
- `packages/shared-types`: `PipelineStage`/`PIPELINE_STAGES`/`PIPELINE_STAGE_LABEL`/`isPipelineStage`/`canTransition`/`Deal`、`ProposalTemplate`/`ProposalSection`、`KpiEvent` 一式 + `DepartmentKpi`、拡張 `TaskStatus`（QUEUED/PENDING_APPROVAL/APPROVED/REJECTED 追加）、`Task.scheduledAt` を正本化。
- Prisma: `Deal` モデル（orgId スコープ + `@@index([orgId, stage])`）、`Task.scheduledAt DateTime?` + `@@index([status, scheduledAt])`。マイグレーション `20260716000000_add_deal_and_task_scheduled_at`（追加のみ・非破壊。`Task.status` は String 列のため承認語彙の追加に DB 変更は不要）。
- 営業パイプラインをインメモリ Map → Prisma `Deal` に置換（org スコープ検証付き）。純粋ロジック（ステージ遷移）は shared-types へ移し DB 無しテストを維持。
- ローカルミラー（gateway kpi-events.ts / web kpiEvents.ts / proposal-templates.ts）を shared-types import に差し替え。

### 2. n8n D1: 生成系を Task/dispatch 化 ✅（直 /llm/chat 廃止・コンプラ#5 の重複ログも解消）
- 新設 `services/generation-dispatch.ts`: `dispatchGenerationTask`（n8n webhook best-effort → AI Engine `/llm/chat` フォールバック）+ `finalizeGenerationOutput`（taskType 別後処理）。
- `POST /api/sales/proposals` / `POST /api/sns/posts` は Task(QUEUED) を作成して **202** を返す非同期モデルに変更（`persist` パラメータ廃止）。完了は proposal→DONE(output={proposal,templateId,model})、sns→**PENDING_APPROVAL**(整形済みドラフト+validation)。n8n コールバック側（webhooks.ts task-complete）も同じ finalize を通す。
- `triggerN8nWorkflowByPath` に `llmOptions`（userPrompt/jsonMode/userEmail=松竹梅）を追加。`isWebhookAvailableByName` を export。
- WF テンプレ `gen-sales-proposal.json`（path `sales-proposal`）/ `gen-sns-draft.json`（path `sns-draft`）を追加（llmBody 転送の WAF-safe シェル形・node retry 付き）。
- 両ルートの直 fetch(/llm/chat) と route 側 `aILog.create` を撤去（AILog は ai-engine 集中ロギングで記録）。
- フロント: SnsPage を非同期生成対応（⏳生成中バッジ + 生成中 3s ポーリング）、SalesPage のステータスラベルを shared TaskStatus 準拠に拡張。

### 3. SNS 段階1: 投稿準備 cron ✅（D2。実投稿はしない）
- `services/sns-publish-prep.ts` `prepDueSnsPosts`: APPROVED + scheduledAt 到来の下書きに `output.publishPrep`（preparedAt/preview/queued/livePosted=false）を付与 + TaskLog。冪等（prep 済みスキップ）・batch 上限 50。`SNS_LIVE_POST=true` でも投稿せず WARN ログのみ（段階2は未解放）。
- `POST /api/webhooks/n8n/sns-publish-prep`（token 認証）+ cron WF テンプレ `sns-publish-prep.json`（15分毎）。
- `PATCH /sns/posts/:id/schedule` は正式カラム `Task.scheduledAt` に保存（output JSON にも UI 互換で複製）。カレンダーはカラム優先で日付解決。

### 4. 分析 KPI アラート ✅（A-6 / 監視系。Task 発火なし・読み取りのみ）
- `services/kpi-alerts.ts`: `evaluateDepartmentAlerts`（純関数）— コスト超過（>2xで HIGH）/ 失敗率（母数 minExecutions 以上）/ p95 レイテンシを判定。コスト・レイテンシは usage-metrics-svc `/metrics/departments`、失敗率は Task groupBy（svc 不達時は失敗率のみ = 優雅な縮退）。
- 超過は RiskEvent（COST_ANOMALY/ANOMALY）として記録 → ガバナンス画面に表示。同一説明文の未解決イベントが窓内にあれば再作成しない（cron 冪等）。
- `POST /api/webhooks/n8n/kpi-alert-check`（token 認証）+ cron WF テンプレ `analytics-alert.json`（毎時）。閾値は env（`KPI_ALERT_*`）。

### 5. pricing gemini=0円 + 既存失敗テスト修繕 ✅
- `usage-metrics-svc pricing.go`: families に `{"gemini", 0.00}` 追加（梅/竹=Gemini 無料枠。known=true・コスト0）。テスト2件追加。
- gateway `kpi-events.ts` / web `kpiEvents.ts` の単価表にも gemini 0 を追加（svc と同一値の原則を維持）。
- 既存失敗テスト（n8n-workflow-builder の 'Build Prompt' ノード参照 = WAF-safe 化 b3714d1 以降の陳腐化）を現行ノード構成（Code ノード無し / llmBody 転送 / Callback POST）の検証に更新。

### 検証
- gateway vitest: **15 files / 109 tests 全パス**（従来 95/96 + 新規 generation-dispatch/sns-publish-prep/kpi-alerts ほか）。
- usage-metrics-svc `go test ./...` 全 green。gateway `tsc --noEmit` / `tsc --noCheck` パス。web `vite build` パス。`prisma format/validate/generate` パス。新規 WF JSON 4本 parse OK。
- 未実施（環境制約）: 実 DB へのマイグレーション適用（`prisma migrate deploy` はデプロイ時に自動）、n8n への WF 取込、本番デプロイ（Render/Vercel 連携張り替えはダッシュボード操作が必要なため残: docs/DEPLOY.md / hamada-phasera-canonical.md）。

### 残タスク（今回スコープ外）
- Render/Vercel の連携張り替え → 本番デプロイ → スモーク（ダッシュボード操作待ち）。
- 段階2（SNS 実投稿）は経営判断での明示解放まで実装しない。
- KPI アラートの Slack/メール通知（現状は RiskEvent = ガバナンス画面連携まで。n8n WF に通知ノードを足せば拡張可能）。
