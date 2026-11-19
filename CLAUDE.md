# CLAUDE.md — FLOW - みんなのAIオフィス プロジェクト指示書

## プロジェクト概要

中小企業向けの「組織型AIエージェント基盤SaaS」を開発する。
社長（ユーザー）が指示を出し、各部署AI（営業部・SNSマーケ部・経理部等）が分担・実行・報告する構造。
AIガバナンス機能（ログ監視・リスク検知）を補助機能として内蔵する。

## 技術スタック (ローカル開発版)

| レイヤー | 技術 | 役割 |
|---|---|---|
| フロントエンド | React 18 + Vite + TypeScript | SPA、社長UI |
| APIゲートウェイ | Node.js (Fastify) + TypeScript | 認証、ルーティング、WebSocket |
| AI処理エンジン | Python 3.11+ (FastAPI) | エージェント実行、Intent分類、リスク検知、LLM呼び出し |
| データベース | PostgreSQL (Prisma) | 本番=Supabase Postgres（us-west-2）/ ローカル=docker-compose |
| LLM | Anthropic Claude + Google Gemini | 松竹梅ルーティング: 梅(STARTER)/竹(PRO)=Gemini無料枠、松(MAX)/admin=Claude。エージェント構築は全ユーザーOpus。LLMRouter経由（docs/llm-provider-tiers.md） |
| ワークフロー | n8n (セルフホスト) | 部署/capability/エージェントの実行基盤。Webhook起動＋AI Engineフォールバック |
| 認証 | JWT自前実装 (bcryptjs + @fastify/jwt) | シンプル認証 |
| ファイル保存 | Supabase Storage（本番）/ ローカル（開発） | 非公開バケット `org-files`。未設定だとローカルに落ち、Render では再デプロイで消える |
| インフラ | docker-compose | ローカル開発環境 |

## リポジトリ構成

```
org-ai-platform/
├── CLAUDE.md
├── apps/
│   ├── web/                   # React SPA (port 3000)
│   ├── api-gateway/           # Fastify (port 4000)
│   ├── ai-engine/             # FastAPI (port 8000)
│   └── n8n-workflows/         # n8n にインポートするワークフロー JSON
├── packages/
│   ├── shared-types/          # 共有TypeScript型定義
│   └── db-schema/             # DBマイグレーション (Prisma + PostgreSQL/pgvector)
├── usage-metrics-svc/         # Go の AILog 集計サービス (読み取り専用)
├── docs/                      # ARCHITECTURE.md ほか設計・運用ドキュメント
├── docker-compose.yml
├── .env.example
└── tasks/                     # エージェントチーム用タスク定義
```

## 開発ルール

- TypeScriptは strict モードを使用する
- Python は型ヒントを必ず付ける
- すべてのAPIエンドポイントにJWT認証を適用する (認証系を除く)
- LLM呼び出しは必ずLLMRouter経由にする（直接呼び出し禁止）
- すべてのAI入出力をAILogテーブルに記録する
- PII検知を通過してからLLMに送信する
- エラーハンドリングは統一フォーマットで返す: `{ success: false, error: { code, message } }`
- 環境変数は .env ファイルで管理する
- 環境変数の読み口は1か所: gateway は `src/config/env.ts`（`envSchema` に追加し既定値は `ENV_DEFAULTS` だけに書く。
  読むときは `config.*`）、ai-engine は `app/config.py`（`settings.*`）。`process.env` / `os.environ` を直接読まない。
  変数を足したら `.env.example` にも載せる（`render.yaml`・compose・Node の版との突き合わせは `npm run check:deploy`、`npm test` に含む）
- gateway のエラー応答は `utils/http-error.ts` の `sendError(reply, status, code, message)` で返す
- gateway のログは `utils/logger.ts` の `createLogger('scope')`（`console.*` 直書き禁止）。ai-engine は
  `logging.getLogger(__name__)`（`print` 禁止）。秘密の値はログにもレスポンスにも出さない
- 変更前後にルートで `npm run lint` / `npm run typecheck` / `npm test` / `npm run build`、
  Python は `npm run lint:ai` / `npm run typecheck:ai` / `npm run test:ai`（`apps/ai-engine/.venv` 前提）、
  Go は `npm run test:go`。CI（`.github/workflows/ci.yml`）も同じことを回す
- DB・マイグレーション・raw SQL を触ったら `npm run test:int`（実 Postgres + pgvector。`TEST_DATABASE_URL` の DB 名は `flow_` 始まり。
  無ければスキップ。CI の integration ジョブが pgvector/pgvector:pg16 で回す）
- テストコードも型チェック対象（gateway / shared-types は `tsconfig.test.json`）。DB・外部 API はモックし、シークレット無しで通すこと
- 構成とデータフローは `docs/ARCHITECTURE.md`、整理で見送った項目・既知の問題は `docs/maintenance/cleanup-hold-list.md`

## 環境変数

```
ANTHROPIC_API_KEY=    # Anthropic APIキー (必須、ai-engine の LLM 呼び出し)
GEMINI_API_KEY=       # Google AI Studio キー (梅/竹プラン用。未設定なら全プランClaudeにフォールバック=課金注意)
GEMINI_PAID_TIER=     # 有料課金に切り替えたら true。⚠️無料枠は入力がGoogleの製品改善に使われる（有料顧客を乗せる前に切替）
ADMIN_EMAILS=         # admin判定 (カンマ区切りemail)。一致ユーザーは常にClaude
JWT_SECRET=           # JWT署名シークレット (必須、32文字以上推奨)
DATABASE_URL=postgresql://...   # Supabase(本番) / docker-compose(ローカル)
FRONTEND_URL=http://localhost:3000   # 本番はカンマ区切りで Vercel ドメインを含める (CORS)
API_GATEWAY_URL=http://localhost:4000
AI_ENGINE_URL=http://localhost:8000
# n8n (任意。未設定なら AI Engine フォールバックで動作)
N8N_CLOUD_URL=        # or N8N_URL。エージェント実行・ワークフロー生成の宛先
N8N_API_KEY=          # n8n Public API キー。エージェント専用ワークフローの動的生成にも使用
N8N_WEBHOOK_AUTH_TOKEN=       # Webhook Header Auth。⚠️ 既定値は公開されているので本番では必ず変える
N8N_CALLBACK_ORG_REQUIRED=false  # n8n コールバックの orgId 必須化（移行期間は false＝無ければ警告して通す）
# セルフサーブ連携 (設定 > 連携)
CHANNEL_CREDENTIAL_ENC_KEY=   # 外部サービスの資格情報の暗号化鍵(32byteをhex/base64)。未設定時はJWT_SECRETから導出
GOOGLE_OAUTH_CLIENT_ID=       # GCP の OAuth クライアント (ウェブアプリ)。docs/self-serve-integrations.md
GOOGLE_OAUTH_CLIENT_SECRET=
ORG_HEADER_MODE=warn          # ai-engine: X-Org-Id と body.org_id の照合 off|warn|enforce
CAPABILITY_CONFIDENCE_THRESHOLD=0.7   # 推論の確信度がこれ未満なら実行せず確認を返す
INTERNAL_SCHEDULER_ENABLED=true       # 定期実行の gateway 内 tick (5分間隔)
# ファイル保存 (本番必須。未設定ならローカル保存＝Renderでは再デプロイで消える)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=    # gateway だけが持つ。ブラウザに渡さない
SUPABASE_STORAGE_BUCKET=org-files
# 決済 (未設定なら「準備中」表示のみ。docs/billing.md)
STRIPE_SECRET_KEY= / STRIPE_WEBHOOK_SECRET= / STRIPE_PRICE_{STARTER,PRO,MAX}_{MONTHLY,YEARLY}=
STRIPE_PRICE_STORAGE_ADDON= / STRIPE_TAX_RATE_ID= / BILLING_TRIAL_DAYS=30 / APP_BASE_URL=
```

## マルチテナント（組織の分離）— docs/design/multi-tenancy.md

- **テナント = Organization**。1人が複数の組織に所属できる。**所属と権限の正本は `Membership(userId, orgId, role, status)`**。
  `User.orgId` は「最後に選んだ組織」、`User.role` は移行期間中の写し（判定に使わない。Phase 3 で削除）。
- **操作する組織は JWT の orgId**（トークン1本 = 1組織）。切り替えは `POST /api/auth/switch-org` で新しいトークンを発行。
  `requireAuth` は毎リクエスト `Membership(sub, orgId)` が ACTIVE かを確認する（30 秒キャッシュ、メンバー管理 API で即破棄）。
  `requireRole` はキャッシュを通さない。エラーは 401(アカウント停止) / 403 `TENANT_ACCESS_REVOKED` / 403 `TENANT_REQUIRED` / 403 `TENANT_NOT_MEMBER`。
- **ルートは `authOf(request).db`（= `tenantDb(orgId)`）だけを使う**。`findUnique({ where: { id } })` にも orgId が自動で付き、
  他組織の id は 404 になる。`create` の orgId も自動、別の orgId を指定すると例外。**ルートから `utils/prisma` を import しない**
  （ESLint の no-restricted-imports と `src/__tests__/architecture.test.ts` で止める。allowlist は理由付きでそこに書く）。
- 別の行を指す参照（agentId / projectId / vendorId など）は `assertSameOrg` か、テナントクライアントでの取得で同じ組織か確かめる。
- raw SQL は `routes/files.ts` と `services/rag.ts` だけ。文には必ず `"orgId"` か `"Organization"` を含める（テストで検査）。
- **新しいモデルに orgId を足したら `src/tenancy/tenant-models.ts` にも足す**（schema.prisma と突き合わせるテストが落ちる）。
- 認証の無い経路（定期実行・LINE webhook・step-runner）は、組織が決まったら `runAsTenant({ orgId, source })` で包む。
  ai-engine への呼び出しは `aiEngineHeaders()` が `X-Org-Id` を付け、ai-engine が body の `org_id` と照合する（`ORG_HEADER_MODE`）。
- 組織分離テスト: `apps/api-gateway/tests/tenancy/tenant-isolation.test.ts`。ルートを足したら IDOR / 一覧の表に足す。
- RLS は Phase 2a まで用意済みで**既定 off**（`RLS_MODE`。設計書 §17）。`packages/db-schema/rls/phase2a.sql`（migrations 外・手で流す）が
  AILog / RiskEvent / FileChunk / MessageEmbedding に `flow_app` 向けのポリシーを付ける。on にするのはロール作成（O-5）の後で、
  gateway・ai-engine の `RLS_MODE=on` と接続ユーザーの `flow_app` への切り替えを**同時に**行う。`SET` は使わず `set_config(…, true)` だけ。
  4 表を触る新しい経路は tenantDb（gateway）か `set_tenant`（ai-engine `app/db.py`）を通すこと。

## 自動化の実行モデル (2026-09 スプリント)

- **連携はユーザーが自分で接続する**。Slack (Bot トークン貼付) と Google (OAuth) は
  `ProviderConnection` に暗号化保存し、gateway の native adapter (`services/adapters/`) が
  直接 API を叩く。n8n credential 非依存 = 顧客追加は DB 行の追加だけ。
  Gmail / X / 既存シート読取は従来どおり n8n 側管理。
- **複数ステップは gateway で順に実行する** (`services/step-runner.ts`)。`Agent.steps` を
  上から実行し、状態は `Task.executionResult` に JSON で毎ステップ保存。
  argTemplate に埋め込めるのは `{{input}}` と `{{prev}}` のみ。
  `llm_transform` は capability を持たない予約ステップ (AI Engine `/llm/chat` 直呼び)。
- **外部送信は必ず人が通す**。`APPROVAL_REQUIRED_CAPS` (send_email / notify_slack /
  post_to_x / send_line_push) は実行前に `PENDING_APPROVAL` で停止し、受信ページの
  「エージェント承認」タブに積まれる。承認 → `resumeAgentTask` で残りを継続。
- **定期実行は `ScheduledTask.agentId`** で紐づく。発火は `services/schedule-dispatcher.ts` に
  集約し、`lastRunAt` の条件付き updateMany による atomic claim で二重発火を防ぐ。
  n8n の schedule-dispatcher と gateway 内 tick (5分) が併走しても安全。

## 経理部 (建設業向け・工事別原価管理)

- **すべて「工事(現場)」単位**。原価は材料費/労務費/外注費/経費の4分類で持つ。
  この区分は建設業会計の標準で、2025年12月全面施行の改正建設業法で見積書への
  内訳記載が努力義務になったものと同じ。
- **金額は税抜で集計する**。`Project.contractAmount` も `CostEntry.amount` も税抜で、
  消費税は `CostEntry.taxAmount` に分けて持つ。入力の入口だけ税込を受け付け、
  `splitTaxInclusive()` がサーバ側で一度だけ割り戻す。
  ⚠️ 一律10%と仮定しない（自社雇用の労務費は不課税。労務費の大きい建設業では試算が大きくずれる）。
- **AI が読んだ数字は DRAFT**。チャット/LINE から入った `CostEntry` は `status=DRAFT` で積まれ、
  人が承認して `CONFIRMED` にするまで台帳の数字にならない。未成工事支出金も CONFIRMED だけを積む。
- **インボイス経過措置は令和8年度税制改正後**: 80% → 70%(2026-10-01) → 50%(2028-10-01)
  → 30%(2030-10-01) → 0%(2031-10-01)。旧スケジュール(2026-10 に 50%)の資料が大量に残っているので、
  触るときは必ず最新の改正を確認すること（回帰テストを置いてある）。
- **LINE で領収書を撮ると原価の下書きになる**。画像は保存せず、抽出結果だけを持つ
  （電子帳簿保存法の保管要件を背負わないため）。工事が1件に絞れないときは明細を作らず人に返す。
- **税務判断はしない**。集計と期日の可視化までに留め、画面にもその旨を出す。

## ファイル保存とプラン容量

- **保存先は行ごとに記録する**（`UploadedFile.storageDriver`）。新規は Supabase、
  移行前の行は `local` のまま残し、読むときは行の driver を使う。本体を失った行は消さずに
  「再アップロードしてください」と出す（RAG の索引 `FileChunk` を守るため）。
- **使用量の真実は `Organization.storageUsedBytes`**。保存と削除で、行の作成/削除と
  **同じトランザクション**で増減する。毎回 `SUM(sizeBytes)` はしない。
- **容量 = プランの無料枠 + 追加容量**（`storageAddonUnits` × 10GB）。判定は
  `canUpload()`（shared-types）1か所だけ。込みは 梅1GB / 竹5GB / 松20GB、1ファイルは 10/20/50MB。
  追加容量は課金開始後（active）にだけ購入できる。
- ⚠️ service_role キーは RLS を貫通する。**組織の切り分けはアプリ側**
  （キーの先頭が orgId、触る前に `keyBelongsToOrg` で確認）。

## 決済 (Stripe)

- **金額はコードに持たない**。Stripe の price ID を環境変数で指す。表示する金額も Stripe から取る。
- **新規契約は Checkout、支払い方法・請求書・解約はカスタマーポータル**。カード情報をこのサーバに通さない。
- **プラン変更と追加容量はアプリ内**（設定 > プラン）。ポータルは複数商品のサブスクリプションを更新できない
  （追加ストレージを買うと明細が2本になる）ので、ポータル側のプラン変更は無効にしておく。
- **組織への写し込みは webhook が正本**。イベントは順不同で届くので、本文の状態を書かずに
  毎回サブスクリプションを取り直して写す（`services/billing/sync.ts`）。処理済みの印は**成功してから**書く。
- 権利があるのは trialing / active / past_due。それ以外は梅の上限に戻す（データは消さない）。
  incomplete 系は未契約と同じ、解約後も `trialEndsAt` の残りは使える。判定は shared-types の `readOnlyReasonOf` 1 か所（gateway と web で共有）。
- **解約後は「閲覧のみ」**。書き込み（POST/PUT/PATCH/DELETE）を 402 で止め、閲覧と書き出しは通す
  （`services/entitlement.ts`）。決済と認証の経路は止めない＝再開できなくなるため。
  認証の無い経路（定期実行・n8n の enqueue と一覧・LINE の下書き/領収書）は入口で `orgEntitlement`（`services/org-entitlement.ts`）を見て
  AI を動かさない（LINE の受信メッセージの保存は続ける）。
  ⚠️ `subscriptionStatus` が null は「まだ決済を繋いでいない」。トライアル期限が無い（既存組織）なら止めない。
- **AI の月間上限は超えても止めない**。8割で警告し、超えたら軽いモデルへ落として続ける
  （ai-engine `governance/usage.py`。判定は LLMRouter 1か所なので n8n 経由にも効く）。
  現場で「今日から使えません」は業務が止まり、そのまま解約になる。
- **登録と同時にカード不要のトライアル**（`trialEndsAt = 作成時刻 + BILLING_TRIAL_DAYS`、上限は梅）。
  期限後も未契約なら「閲覧のみ」（402 `SUBSCRIPTION_REQUIRED`）。判定は `entitlementOf`（`services/entitlement.ts`）1か所。
  ⚠️ `trialEndsAt` が null の既存組織と、決済未設定（キーか梅の月額 price が無い）の環境は止めない。
- トライアルは作成者ごとに1回。自分で作った2つ目以降の組織は作成時点で期限切れ（契約するまで閲覧のみ）。
- 登録時トライアル中の Checkout は残り期間を `trial_end` で引き継ぐ（48 時間未満ならその日から課金。一度契約した組織には付けない）。
  「決済設定済み」はキー・梅の月額 price・`STRIPE_WEBHOOK_SECRET` の 3 つ（`config.billingConfigured`。署名鍵が無ければ Checkout も 503）。テストモードの用意は `npm run stripe:bootstrap`（docs/billing.md）。
- SDK は入れない（LINE・Supabase と同じ）。シークレットと Stripe のエラー文言は利用者に返さない。

## 設定が入っているかの確認

- **設定 > 基本 の「セットアップ状況」**（オーナーのみ・`GET /api/organizations/me/setup`）。
  環境変数の有無ではなく、**保存先を実際に読みに行き、ai-engine に実際に1回投げて**判定する
  （値が間違っていても「入ってはいる」ので、有無だけでは確認にならない）。
- ⚠️ 秘密の値は返さない。状態と直し方だけ。メンバーには見せない（未設定という情報自体が攻撃の手がかり）。
- ai-engine の確認は空の本文を投げるだけで LLM は呼ばない（本文の検証で弾かれる）。

## スマホ・公開ページ・入口の守り（2026-11 SaaS 化。docs/plan/saas-readiness-plan.md §2）

- **スマホで開ける画面は `shell/navConfig.ts` の表 1 つ**（各行の `mobile`）。開けるのは TOP・チャット・受信・成果物・
  エージェント一覧と実行・経理・設定（契約までスマホで完結）。エージェント詳細・ガバナンス・タスク・営業・分析・SNS は
  パソコン（`DesktopOnly`）。ルートを足したら `navConfig.test.ts` の表にも足す（D6）。
- **PWA は manifest とアイコンだけ。service worker は入れない**（古い画面とトークンが残る事故を避ける。D7）。
- **レート制限は `@fastify/rate-limit` のメモリ保持**（gateway 1 台の前提。複数台にするなら保持先を替える。D8）。
  IP は `TRUST_PROXY_HOPS` 段だけ信じる。除外は `isRateLimitExempt` の 1 か所（docs/security.md）。
- **法務の 3 頁（`/legal/terms` `/legal/privacy` `/legal/tokushoho`）は認証の外**。見出しと項目だけで、
  文面と事業者情報は `pages/legal/content.ts` の `value: null`（画面に「未記入」）をオーナーが埋める。ここで文面を作らない。
- **デプロイ手順は `docs/DEPLOY.md` の 1 本**（`DEPLOYMENT_RUNBOOK.md` は案内だけ）。render.yaml に `sync: false` の
  キーを足したら DEPLOY.md にも書く（`npm run check:deploy` が検査）。

## 業務ページ（n8n 連携）— docs/design/custom-pages.md

- **組織ごとの画面 `/p/:slug`**。定義は DB の `CustomPage`（許可リストの 7 ブロック＋アクション）が正本。n8n は「登録する人」と「データを出す人」。
  検証は shared-types の `pages.ts`（zod・`.strict()`）1 か所、上限は `pages-plan.ts` の `PAGE_LIMITS`（ページ数・月間の送信数）。
- **届く先は gateway が組み立てる**: `${N8N の URL}/webhook/pages/<JWT の orgId>/<hook>`。定義に書けるのは `hook` だけ（任意 URL 禁止）。
  ai-engine へのフォールバックはしない（未接続を出す）。応答は `projectQueryResult` で切り詰めてから web へ。web は `dangerouslySetInnerHTML` を使わない。
- **登録は組織ごとの登録トークン**（`x-page-token`、ハッシュ保存、有効 2 本）。共有トークンでは登録できない。n8n は SEED / MANUAL の行を上書きしない（409）。
- 送信は `PageActionLog` に項目名だけ記録し月間件数を数える。取得（GET）は数えず「閲覧のみ」でも通る。
- **開発**: seed（`packages/db-schema/prisma/seed-pages.ts` が定義の正本）＋ `PAGES_SAMPLE_MODE=true` で n8n 無しに `/p/inquiries` が動く（本番は常に無効）。
  n8n のサンプル `apps/n8n-workflows/pages/page-inquiries.json` は `__ORG_ID__` を置き換えて手で入れる（`n8n:import` は `pages/` を拾わない）。手順は `docs/custom-pages-n8n.md`。

## ホームキャンバスと業務フロー — docs/design/canvas-home.md

- **ホーム `/` は業務の地図**（`Canvas` は組織に 1 枚）。ノードの行き先はフロー・テンプレート・既存の画面。テンプレートは押した瞬間に複製（LLM を使わない）。
- **フローの論理（順番・分岐・承認）は FLOW の DB**（`Flow` / `FlowVersion` / `FlowRun`）。ノードは 7 種の許可リスト（shared-types `flows.ts`）。
  ランナーは gateway 内（`services/flows/`）、キューは `FlowRun` の表。外へ送るノードの直前で**必ず**止まる。
- **n8n は運営の部品だけ**（`parts/<key>`。`docs/flow-parts-n8n.md`）。⚠️ お客さんの操作で n8n のワークフローを作る・変える経路を作らない
  （`services/flows/` `routes/flows.ts` `routes/canvas.ts` は public API・`n8n-workflow-builder` を読まない。ソーステストで固定）。
- **結果ページ**は `CustomPage(source='FLOW', flowId)`。出力ビルダー（フロー画面の「出力」）だけが定義を書き、ページ数の上限に数えない。
  `/p/:slug` の `flow_query` / `flow_submit` は n8n を呼ばず、実行はフローの実行として 1 回だけ数える（`PageActionLog` に書かない）。
- 上限は `FLOW_LIMITS`（flows-plan.ts）の 1 か所。設定 > プラン に フロー・実行・部品 の 3 行（`/me/usage`）。

## エージェント機能 (業務効率化エージェント)

- ユーザーはチャット/フォームから再利用可能なエージェントを作成 (`POST /api/agents`)。
- 作成時に n8n Public API で専用ワークフロー `agent-<id>` を **best-effort 生成** (`n8n-workflow-builder.ts`)。
  n8n が落ちていても作成は成功し `n8nStatus=PENDING`、実行時は AI Engine `/llm/chat` にフォールバック。
- 一覧 (`GET /api/agents`) から選択して再実行 (`POST /api/agents/:id/run`) → `Task` を作成し
  `dispatchAgentTask` が n8n webhook（コールドスタート時はリトライ＋「n8n起動中…」ログ）→ フォールバックで実行。
- フロント: `/agents` ページ (一覧/作成/実行)、`CreateAgentModal` / `AgentRunModal`。
- DB が真実の源。n8n は自動化の加速レイヤーであって依存先ではない。

## Render プランと稼働方針

**現行: 3 サービスとも `starter`（スリープ無しの常時稼働）** — `render.yaml` で宣言。
- `starter` でも RAM は増えない想定なので、n8n の `NODE_OPTIONS` ヒープ調整は据え置き（OOM 対策）。
- 常時稼働のため `.github/workflows/keepalive.yml` の定期実行は停止済み（手動実行のみ残置）。
- 価格・スペックは変動するので、課金前に Render の料金ページで要確認。

`free` に戻す場合の制約と緩和策:
- ~15分でスリープ・750h/月の枠があり 3 サービスの 24h 常時稼働は不可。
- keepalive.yml の `schedule` を復活（平日 JST 9-19 のみ health を叩く＝月 ~220h/サービスで枠内）。
- 実行は常に AI Engine フォールバックで完了するため n8n スリープ中でも動く。
- 課金優先度は **api-gateway > ai-engine > n8n**（gateway は全 API の入口、n8n はフォールバックがあるため最後）。

## タスク実行順序

Phase 1 (並列): tasks/00-setup.md + tasks/01-database.md
Phase 2 (並列): tasks/02-auth.md + tasks/03-llm-router.md
Phase 3 (依存): tasks/04-agent-framework.md
Phase 4 (並列): tasks/05-governance.md + tasks/06-frontend.md + tasks/07-file-access.md
Phase 5 (最終): tasks/08-integration.md
