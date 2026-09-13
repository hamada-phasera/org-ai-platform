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
│   └── ai-engine/             # FastAPI (port 8000)
├── packages/
│   ├── shared-types/          # 共有TypeScript型定義
│   └── db-schema/             # DBマイグレーション (Prisma + SQLite)
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

## 環境変数

```
ANTHROPIC_API_KEY=    # Anthropic APIキー (必須、ai-engine の LLM 呼び出し)
GEMINI_API_KEY=       # Google AI Studio 無料キー (梅/竹プラン用。未設定なら全プランClaudeにフォールバック=課金注意)
ADMIN_EMAILS=         # admin判定 (カンマ区切りemail)。一致ユーザーは常にClaude
JWT_SECRET=           # JWT署名シークレット (必須、32文字以上推奨)
DATABASE_URL=postgresql://...   # Supabase(本番) / docker-compose(ローカル)
FRONTEND_URL=http://localhost:3000   # 本番はカンマ区切りで Vercel ドメインを含める (CORS)
API_GATEWAY_URL=http://localhost:4000
AI_ENGINE_URL=http://localhost:8000
# n8n (任意。未設定なら AI Engine フォールバックで動作)
N8N_CLOUD_URL=        # or N8N_URL。エージェント実行・ワークフロー生成の宛先
N8N_API_KEY=          # n8n Public API キー。エージェント専用ワークフローの動的生成にも使用
N8N_WEBHOOK_AUTH_TOKEN=org-ai-n8n-secret-token   # Webhook Header Auth
# セルフサーブ連携 (設定 > 連携)
CHANNEL_CREDENTIAL_ENC_KEY=   # 外部サービスの資格情報の暗号化鍵(32byteをhex/base64)。未設定時はJWT_SECRETから導出
GOOGLE_OAUTH_CLIENT_ID=       # GCP の OAuth クライアント (ウェブアプリ)。docs/self-serve-integrations.md
GOOGLE_OAUTH_CLIENT_SECRET=
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
- **容量 = プランの無料枠 + 追加容量**（`storageAddonUnits` × 1GB）。判定は
  `canUpload()`（shared-types）1か所だけ。追加容量は課金開始後に購入できるようにする。
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
- トライアルは組織ごとに1回（`trialEndsAt` が一度でも入ったら使用済み）。
- SDK は入れない（LINE・Supabase と同じ）。シークレットと Stripe のエラー文言は利用者に返さない。

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
