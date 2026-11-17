# FLOW SaaS 化 実装計画（2026-11-17）

**一行要約: 課金の部品（Checkout・webhook・閲覧のみ化・容量上限）は既にあるが、「払わなくても梅のまま永久に使える」「スマホから契約画面に行けない」「compose が一発で起動しない」の3点が DoD を塞いでいるので、登録時トライアル → 上限と 402 の導線 → Stripe テスト一式 → モバイル → デプロイ再現性 → 実 DB 通しテストの順に 12 チャンクで埋める。**

- 対象ブランチ: `feat/saas-billing-mobile`（PR #7 `feat/multi-tenancy` の上）
- 設計軸（web React/Vite・gateway Fastify・ai-engine FastAPI・Postgres+pgvector/Prisma・n8n 任意・DESIGN.md v3）は変えない
- この文書は計画だけ。コードの変更は含まない
- 調査は 2026-11-17 時点のコードを読んだ結果。テストやビルドは**実行していない**（読んだだけ）

---

## 0. DoD と現状の対応

| DoD の段 | 現状 | 塞いでいるもの | 埋めるチャンク |
|---|---|---|---|
| セルフサインアップ → 自分の Organization | 済 | メール小文字化なし、レート制限なし | 7 |
| PC とスマホで使う | 一部 | スマホは 4 画面のみ。設定（プラン）が開けない。manifest なし | 5, 6 |
| プラン上限に当たる | 一部 | 容量は止まる。AI は降格のみで画面の導線が設定内だけ。`/rank` などが回数に入らない | 2, 4 |
| 支払う（Stripe test） | 一部 | 未契約（`subscriptionStatus = null`）は永久に全機能。支払う理由が発生しない | 1, 2, 3 |
| 再現可能なデプロイ | 未 | compose に pgvector なし、`.env` 必須、Dockerfile が Node 20、render.yaml に欠けたキー | 8 |
| 通しで証明 | 未 | 実 Postgres の統合テストなし | 9 |

---

## 1. ギャップ分析

凡例: **済** = 実装あり（根拠ファイル） / **一部** = あるが DoD に足りない / **未** = 無い

### 1.1 サインアップ・オンボーディング

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| 登録で組織・本人・所属を 1 トランザクションで作成 | 済 | `apps/api-gateway/src/routes/auth.ts`（`/register`） |
| 既定ノード（Capability）の投入 | 済 | `services/organizations.ts` `seedDefaultCapabilities` |
| 2 つ目以降の組織作成、上限 10 | 済 | `routes/organizations.ts`、`MAX_ORGS_CREATED_PER_USER` |
| 組織の切り替え、所属なし画面 | 済 | `routes/auth.ts`（`/switch-org`）、`apps/web/src/pages/NoOrgPage.tsx`、`components/org/OrgSwitcher` |
| 招待（リンク発行・受諾・既存ユーザー受諾） | 済 | `routes/members.ts`、`pages/InvitePage.tsx`。メール送信は無く、リンクを手で渡す |
| 登録時のトライアル開始 | **未** | `/register` は `plan: 'STARTER'` を入れるだけ。`trialEndsAt` は Checkout を通るまで null |
| メールの正規化 | **未** | `/register` `/login` が入力そのままで `findUnique`。`A@x.jp` と `a@x.jp` が別人になる |
| メール確認・パスワード再設定 | **未** | メール送信の仕組み自体が無い（オーナー依頼 O-6） |
| 初回の案内 | **未** | 登録後は TOP に着地するだけ。次にやることが出ない |
| 利用規約・特商法・プライバシーの頁 | **未** | `apps/web/src` と `marketing/` に該当なし。Stripe の審査と有償販売に必要 |

### 1.2 課金・webhook

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| Checkout（新規契約）、顧客 ID の競合対策 | 済 | `routes/billing.ts`（`/checkout`） |
| カスタマーポータル | 済 | `routes/billing.ts`（`/portal`） |
| アプリ内プラン変更、ダウングレード時の容量確認 | 済 | `routes/billing.ts`（`/change-plan`） |
| 追加ストレージ | 済 | `routes/billing.ts`（`/storage-addon`）、`billing-core.ts` `buildAddonItems` |
| webhook: raw body 署名検証、冪等、順不同対策、成功後に印 | 済 | `routes/billing-webhook.ts`、`services/billing/webhook-handler.ts`、`sync.ts`、`BillingEvent` |
| 解約後は閲覧のみ（402） | 済 | `services/entitlement.ts`、`middleware/auth.ts` |
| トライアルは作成者ごとに 1 回 | 済 | `services/organizations.ts` `creatorTrialUsed` |
| 価格は Stripe から取得 | 済 | `routes/billing.ts` `priceAmount`（10 分キャッシュ） |
| 課金のテスト | 済 | `apps/api-gateway/tests/billing/*`（4 ファイル）、`tests/auth/entitlement.test.ts` |
| **未契約の組織を課金に向かわせる仕組み** | **未** | `entitlementOf(null)` は `full`。新規登録の組織は永久に梅で使える。これが最大の穴 |
| web の 402 処理 | **未** | `apps/web/src/services/api.ts` の interceptor は 401 と 403 だけ。402 は各画面の汎用エラーになる |
| Stripe 側の用意の自動化 | **未** | `docs/billing.md` は手作業の手順。商品 7 本・税率・ポータル・webhook を手で作る |
| 設定の読み口 | 一部 | `billing-core.ts` `billingConfigFromEnv` が `process.env` を直接読む（CLAUDE.md の「読み口は 1 か所」に反する） |
| 追加容量の単位の表記 | 一部 | コードは 10GB（`STORAGE_ADDON_UNIT_BYTES`）。`routes/billing.ts` と `schema.prisma` のコメント、`docs/billing.md` の一部が「1GB」 |
| 解約 90 日後の削除 | 未 | 運用で行う方針（`docs/billing.md`）。今回は対象外 |

### 1.3 プラン上限の強制と計測

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| 容量・1 ファイル上限の判定 1 か所 | 済 | `packages/shared-types/src/index.ts` `canUpload` |
| 容量の原子的な加算 | 済 | `routes/files.ts`（条件付き `updateMany`） |
| AI 月間上限: 8 割で警告、超過で降格 | 済 | `apps/ai-engine/app/governance/usage.py`、`llm/router.py` |
| 上限値の両側検証 | 済 | `tests/fixtures/plan-models.json`、`apps/api-gateway/tests/plan-models.test.ts`、`apps/ai-engine/tests/test_plan_models.py` |
| 利用量 API と表示 | 済 | `routes/organizations.ts`（`/me/usage`）、`components/Settings/UsageCard.tsx`、`shell/Sidebar.tsx` |
| `/rank` と `screen_agent` の計上 | **未** | `apps/ai-engine/app/main.py`、`planner/planner.py`。AILog に残らず回数に入らない |
| `/orchestrate` のログ | **未** | `orchestrator/orchestrator.py` がマスク前の入力を AILog に書く |
| AILog の model | 一部 | `/plan` は降格前のモデル名を記録する |
| 上限到達時の導線 | 一部 | 警告は設定とサイドバーだけ。スマホには出ない。容量超過のエラーから契約画面へ行けない |
| ai-engine が受け取る plan | 一部 | body の値を信じる（設計書 Q5）。gateway は DB の値を送るので実害は n8n 経由だけ。今回は対象外 |

### 1.4 テナント分離・RLS

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| ルートは `tenantDb` のみ | 済 | `tenancy/tenant-db.ts`、`src/__tests__/architecture.test.ts`、ESLint |
| 毎リクエストの所属確認 | 済 | `middleware/auth.ts`、`tenancy/membership-cache.ts` |
| 分離テスト（IDOR・一覧） | 済 | `apps/api-gateway/tests/tenancy/tenant-isolation.test.ts`（偽 Prisma） |
| ai-engine の `X-Org-Id` 照合 | 済 | `apps/ai-engine/app/tenancy.py`、`ORG_HEADER_MODE`（既定 warn） |
| services の `tenantDb` 化 | **未** | 素の prisma を使う: `task-executor.ts` `capability-resolver.ts` `capability-executor.ts` `step-runner.ts` `rag.ts` `adapters/index.ts` `google-auth.ts` `integration-sync.ts` `inbox/{draft-generator,line-inbox,receipt-capture}.ts` |
| RLS ポリシー | **未** | 草案のみ `docs/design/rls-phase2-draft.sql`。接続ロールの分離が前提 |
| 実 Postgres での検証 | **未** | raw SQL（`routes/files.ts`、`services/rag.ts`）は文字列検査だけ |
| n8n コールバックの orgId 必須化 | 一部 | `N8N_CALLBACK_ORG_REQUIRED` 既定 false。今回は変えない |

### 1.5 モバイル

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| 下部タブ、メニュー、組織スイッチャー | 済 | `components/shell/MobileNav.tsx` |
| スマホ非対応画面の誘導 | 済 | `shell/DesktopOnly.tsx`、`AppShell.tsx` |
| スマホで開ける画面 | 一部 | `/` `/chat` `/inbox` `/deliverables` のみ。**`/settings` が開けず、スマホから契約できない** |
| ルート定義の一本化 | **未** | `navConfig.ts` `MOBILE_ROUTES` と `MobileNav.tsx` `TABS` / `MOBILE_OK` が二重（DESIGN.md §4 に注記あり） |
| PWA manifest・アイコン | **未** | `apps/web/index.html` に manifest なし。`public/` は `characters/` だけ |
| セーフエリア・動的ビューポート | **未** | viewport に `viewport-fit=cover` なし。`AppShell` は `h-screen`。下部ナビに safe-area の余白なし |
| タッチターゲット 44px | 一部 | タブは 56px。`BillingSection.tsx` の増減ボタンは 28px（`h-7 w-7`） |
| 登録・ログインの画面幅 | 要確認 | `RegisterPage.tsx` `NoOrgPage.tsx` にブレークポイント指定なし。実機幅での確認はしていない |

### 1.6 セキュリティ

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| JWT 秘密鍵 32 文字未満で起動拒否 | 済 | `apps/api-gateway/src/index.ts` |
| CORS 許可リスト | 済 | `index.ts`。ただし本番でも `localhost` を許可している（低） |
| PII 検知 | 済 | `apps/ai-engine/app/governance/pii_screener.py`、router で送信直前に適用 |
| 資格情報の暗号化 | 済 | `services/secret-box.ts` |
| 権限は DB の Membership で判定 | 済 | `middleware/auth.ts` `requireRole` |
| レート制限 | **未** | gateway・ai-engine とも無し。`/login` `/register` が総当たり可能 |
| n8n トークン既定値での本番起動 | **未** | `config/env.ts` に判定（`n8nWebhookAuthTokenIsDefault`）はあるが、起動は止めない |
| 管理操作の監査記録 | **未** | AILog と RiskEvent は AI の入出力だけ。招待・役割変更・契約操作の記録が無い |
| エラー文言の漏れ | **未** | gateway `/ready` が DB 例外文言を返す。ai-engine `/orchestrate/stream` が `str(e)` を返す |
| ai-engine の内部認証 | 一部 | `INTERNAL_API_TOKEN` 未設定なら素通し。`/docs` `/openapi.json` は常に公開 |
| ログの規約 | 一部 | `index.ts` に `console.log` / `console.error` が 2 か所 |

### 1.7 デプロイ再現性・運用

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| render.yaml に 3 サービス、migrate のリトライ | 済 | `render.yaml` |
| 終了時のドレイン、取り残し実行の回収 | 済 | `services/lifecycle.ts`、`step-runner.ts` `recoverStaleRunningTasks` |
| セットアップ状況の実確認 | 済 | `services/setup-status.ts`、`components/Settings/SetupStatusCard.tsx` |
| CI（lint・型・テスト・ビルド、Node 22） | 済 | `.github/workflows/ci.yml` |
| compose の Postgres | **未** | `postgres:16-alpine`。`CREATE EXTENSION vector` で migrate が落ちる |
| compose の `.env` | **未** | 3 サービスが `env_file: .env`。ファイルが無いと起動しない。`JWT_SECRET` が無いと gateway が落ちる |
| Dockerfile の Node | **未** | `apps/api-gateway/Dockerfile` `apps/web/Dockerfile` が `node:20-alpine`。undici 8 は 22.19 以上 |
| Render の Node 指定 | **未** | `render.yaml` に `NODE_VERSION` なし、リポジトリに `.node-version` なし、`package.json` に `engines` なし |
| render.yaml の欠けたキー | **未** | `ALLOWED_ORIGIN_HOSTS` `ORG_HEADER_MODE` `N8N_CALLBACK_ORG_REQUIRED` が無い |
| Vercel 設定の食い違い | **未** | `vercel.json` は `apps/web/dist`、プロジェクト側は rootDirectory=`apps/web`。prebuilt でしか通らない（`docs/DEPLOY.md`） |
| `AI_ENGINE_URL` の既定値 | **未** | `config/env.ts` に 2 種類（`localhost` と `ai-engine`） |
| ai-engine の `DATABASE_URL` 既定値 | **未** | `app/config.py` が SQLite（`file:./data/app.db`）。未設定だと AILog が黙って欠け、上限判定も効かない |
| `scripts/start-dev.sh` | **未** | SQLite 時代の初期化が残る |
| 環境変数の突き合わせ | **未** | `envSchema`・`.env.example`・`render.yaml` を照合するテストが無い |
| usage-metrics-svc | 対象外 | render.yaml にも compose にも無い。分析画面は未接続表示で動く |

### 1.8 ドキュメント

| 項目 | 状態 | 根拠・不足 |
|---|---|---|
| 設計・課金・移行の文書 | 済 | `docs/design/multi-tenancy.md`、`docs/billing.md`、`docs/supabase-migration.md`、`docs/ARCHITECTURE.md` |
| デプロイ手順 | 一部 | `DEPLOYMENT_RUNBOOK.md` と `docs/DEPLOY.md` が並立。後者は「Render 停止中」「Neon」など古い記述を含む |
| 顧客向けの手順（登録〜支払い） | 未 | 無し |

---

## 2. 設計上の決定（この計画で新しく置くもの）

採用済みの 4 点（Node 22、n8n トークン既定値の起動拒否、ai-engine のログと計上、PR #7 の推奨値）はそのまま使う。以下はこの計画で足す決定。オーナーの確認が要るものは §5 に再掲する。

| # | 決定 | 理由 | 既存方針との関係 |
|---|---|---|---|
| D1 | **登録と同時にカード不要のトライアルを始める**。`trialEndsAt = 作成時刻 + BILLING_TRIAL_DAYS` | 支払いの期限を作る。列は既にあり、マイグレーション不要 | 「一度でも入ったら使用済み」と整合。Checkout では二重に無料期間を出さない |
| D2 | **未契約かつトライアル切れは閲覧のみ**。条件は `subscriptionStatus = null` かつ `trialEndsAt < now` かつ決済が設定済み | 既存の 402 の仕組みをそのまま使える | CLAUDE.md の「null は止めない」は、`trialEndsAt = null` の既存組織について維持する。決済未設定の環境では誰も止めない（再開手段が無いため） |
| D3 | トライアル中に契約したら、残り期間を Checkout に引き継ぐ（`subscription_data.trial_end`） | 早く契約した人が損をしない | Stripe の下限（48 時間以上先）を実装前に公式文書で確認する。満たさなければ即課金 |
| D4 | 作成者の 2 つ目以降の組織は、作成時点で `trialEndsAt = 作成時刻`（契約するまで閲覧のみ） | 採用済みの「トライアルは作成者ごとに 1 回」を、D2 の下でも成り立たせる | PR #7 の「課金まで梅の上限」より厳しくなる。オーナー確認 O-9 |
| D5 | トライアル中の上限は梅 | 追加の分岐を作らない | — |
| D6 | スマホで開ける画面に `/settings` `/accounting` `/agents`（一覧と実行）を足す。エージェント詳細・ガバナンス・タスク・営業・分析・SNS はパソコンのまま | 契約と日常業務をスマホで完結させる | DESIGN.md §4 の「分担」は維持し、範囲だけ広げる |
| D7 | service worker は入れない。manifest とアイコンだけ | 古い画面とトークンが残る事故を避ける | — |
| D8 | レート制限は `@fastify/rate-limit`（メモリ保持） | gateway は 1 台の想定（設計書 §15-9） | 複数台にするときは保持先を変える |
| D9 | RLS は opt-in（`RLS_MODE`、既定 off）。本番の有効化はロール作成後 | Supabase のロール作成はオーナー作業 | ADR-4 の Phase 2a に相当 |

---

## 3. 実装チャンク

### 共通の決まり

| 項目 | 内容 |
|---|---|
| 順序 | 番号順。1〜9 が DoD に必須。10〜12 は時間が残れば |
| 1 チャンク | 1〜2 時間。終わるたびにコミットする |
| 各チャンクの終了条件 | ルートで `npm run lint` `npm run typecheck` `npm test` `npm run build` が通る。Python を触ったら `npm run lint:ai` `npm run typecheck:ai` `npm run test:ai`。web を触ったら `npm run check:tokens --workspace=apps/web` |
| 守ること | CLAUDE.md の開発ルール全部。特に: 環境変数は `config/env.ts` と `app/config.py` 経由、`sendError`、`createLogger`、ルートから `utils/prisma` を import しない、変数を足したら `.env.example`、モデルに orgId を足したら `tenant-models.ts` |
| UI | フラット・白・余白と区切り線と表。色付きの左アクセントバー禁止、カードの入れ子禁止、文字は最小限、ラベルは一語。`components/ui/` の部品と既存トークンだけを使う |
| 外部 | 実際のデプロイ・有料アカウント・本物の Stripe キーは使わない。Stripe はモック |
| 詰まったとき | 1 チャンクが 2 時間を超えたら、受け入れ条件のうち通ったものをコミットし、残りをこの文書の末尾に追記して次へ進む |

### チャンク 1: 登録時トライアルと期限切れの閲覧のみ化

| 項目 | 内容 |
|---|---|
| 目的 | 支払う理由を作る（D1・D2・D4・D5）。DoD の「上限に当たる → 支払う」の入口 |
| 触るファイル | `apps/api-gateway/src/routes/auth.ts`、`services/organizations.ts`、`services/entitlement.ts`、`middleware/auth.ts`、`tenancy/membership-cache.ts`、`routes/billing.ts`（overview）、`config/env.ts`、`packages/shared-types/src/index.ts`（`BillingOverview`）、`CLAUDE.md`（決済の節）、`docs/billing.md` |
| 実装の要点 | `entitlementOf` を `{ status, trialEndsAt, billingConfigured, now }` を取る純粋関数にする。キャッシュの写しに `trialEndsAt` を足す（判定は要求時刻で行う）。`/register` と `createOrganizationFor` で `trialEndsAt` を入れる。overview に `appTrial: { active, endsAt, daysLeft }` を足す。402 のコードは `SUBSCRIPTION_REQUIRED` のまま、文言だけトライアル切れ用を分ける |
| 受け入れ条件 | (1) 登録直後の組織は `trialEndsAt` が 30 日後で、書き込みが通る (2) 時刻を 31 日後にすると POST が 402、GET は 200、`/api/billing/*` と `/api/auth/*` は通る (3) `STRIPE_SECRET_KEY` 未設定なら 31 日後も 402 にならない (4) `trialEndsAt = null` かつ `subscriptionStatus = null` の既存組織は従来どおり通る (5) 同じ作成者の 2 つ目の組織は作成直後から書き込みが 402 (6) `trialing` `active` `past_due` は `trialEndsAt` に関係なく通る |
| 追加するテスト | `tests/auth/entitlement.test.ts` に上の 6 条件の表。`tests/auth/auth.route.test.ts` に登録時の `trialEndsAt`。`tests/billing/billing.route.test.ts` に overview の `appTrial` |
| やらないこと | 既存組織へのトライアル付与（SQL を `docs/billing.md` に書くだけ）。トライアル終了のメール通知。トライアル中の上限の変更 |

### チャンク 2: web の契約状態・上限・402 の導線

| 項目 | 内容 |
|---|---|
| 目的 | 上限と期限を見せ、どの画面からでも契約画面に行けるようにする |
| 触るファイル | `apps/web/src/services/api.ts`、`components/shell/AppShell.tsx`、新規 `components/shell/PlanNotice.tsx`、新規 `utils/planNotice.ts`、`components/Settings/BillingSection.tsx`、`components/Settings/UsageCard.tsx`、アップロードのエラー表示（`ChatPage.tsx` とファイル関連） |
| 実装の要点 | 表示の判定は純粋関数 `planNoticeOf(billing, usage, now)` に置き、`trial`（残り 7 日以下）/ `expired` / `ai-warn` / `ai-over` / `storage-warn` / `storage-over` / `none` を返す。`AppShell` の本文の上に 1 行の帯（白地・下罫線・文言 1 文・リンク 1 つ）。402 は interceptor で受け、帯を `expired` にして `/settings?tab=billing` へのリンクを出す（`alert` は使わない）。容量超過（`QUOTA_EXCEEDED` / `FILE_TOO_LARGE`）のエラーにも同じリンクを付ける。Checkout の文言は `appTrial` の残りに合わせる |
| 受け入れ条件 | (1) `planNoticeOf` が 7 状態を正しく返す (2) 402 を受けた要求は例外を投げ直し、ログアウトしない (3) 帯は PC とスマホの両方に出る (4) `check:tokens` が 0 件 (5) 帯に左アクセントバーと入れ子のカードが無い |
| 追加するテスト | `apps/web/src/utils/__tests__/planNotice.test.ts`（境界値: 残り 7 日・0 日、8 割ちょうど、上限ちょうど）。`services/__tests__/api-402.test.ts` |
| やらないこと | 価格表のデザイン変更。モーダルでの強制表示。画面の実機確認（オーナー依頼 O-10） |

### チャンク 3: Stripe テストモード一式

| 項目 | 内容 |
|---|---|
| 目的 | オーナーがテストキーを 1 つ入れれば契約まで通る状態にする。課金の流れを通しで固定する |
| 触るファイル | 新規 `scripts/stripe-bootstrap.mjs`、`package.json`（`stripe:bootstrap`）、`apps/api-gateway/src/services/billing/billing-core.ts`、`config/env.ts`、`routes/billing.ts`、`routes/billing-webhook.ts`、新規 `apps/api-gateway/tests/billing/billing-flow.test.ts`、`tests/helpers/`（偽 Stripe）、`docs/billing.md`、`packages/db-schema/prisma/schema.prisma`（コメントのみ） |
| 実装の要点 | bootstrap は依存ゼロ・既定は確認のみ・`--apply` で作成・`sk_live_` を拒否・冪等（`lookup_key` と metadata で既存を探す）。作るもの: 商品と価格 7 本（JPY 税抜、`docs/billing.md` の表）、税率（外税 10%）、ポータル設定（プラン変更を無効、期間末解約）、webhook エンドポイント（URL 指定時）。最後に貼り付け用の環境変数を出す（シークレットキー自体は出さない）。`billingConfigFromEnv` は `config` 経由に直す。D3 の `trial_end` 引き継ぎを `buildCheckoutParams` に足す。追加容量の「1GB」表記を 10GB に揃える |
| 受け入れ条件 | (1) 偽 Stripe で次が 1 本のテストで通る: 登録 → Checkout URL 取得 → `checkout.session.completed` → プランが竹 → `/me/usage` の上限が 8000 と 5GB → `subscription.updated`（past_due）でも書き込み可 → `subscription.deleted` で書き込み 402 → 再 Checkout → 復帰 (2) 署名違いは 400、同じイベント ID の再送は `duplicate` (3) トライアル残り 10 日なら Checkout に `trial_end`、残り 1 日なら付かない (4) `sk_live_` を渡すと bootstrap が何も作らず終了する (5) `src/` 内で `process.env` を読むのは `config/env.ts` だけ |
| 追加するテスト | 上の通しテスト。`billing-core.test.ts` に `trial_end` の 3 ケース。`scripts/stripe-bootstrap.mjs` の引数検証（`node --test`）。`architecture.test.ts` に「`process.env` は `config/env.ts` だけ」 |
| やらないこと | 本物の Stripe への接続。SDK の導入。請求書画面の自作。解約 90 日後の自動削除。`invoice.*` イベントの個別処理（サブスクリプションのイベントで足りる） |

### チャンク 4: 利用量の計測を正す（ai-engine）

| 項目 | 内容 |
|---|---|
| 目的 | 上限の回数を実態に合わせ、記録の方針違反を消す（採用済み判断 3 と残課題） |
| 触るファイル | `apps/ai-engine/app/orchestrator/orchestrator.py`、`app/main.py`、`app/planner/planner.py`、`app/config.py`、`apps/ai-engine/tests/` |
| 実装の要点 | `/orchestrate` は `screen(user_message).text` を記録する。`/rank` と `screen_agent` に `schedule_llm_log` と `note_call` を足す。`/plan` は応答の実モデル名を記録する。`/orchestrate/stream` と `/orchestrate` のエラーは固定文言にし、詳細はログへ。`DATABASE_URL` 未設定を起動時に警告する（既定値の SQLite は `tests/test_config.py` が固定しているので、変えるならテストごと直す） |
| 受け入れ条件 | (1) メールアドレスを含む入力で `/orchestrate` を呼ぶと、記録された入力にその文字列が無い (2) `/rank` を 1 回呼ぶと AILog の記録が 1 件予約され、利用量のキャッシュが 1 進む (3) `screen_agent` も同じ (4) ストリームでプロバイダが例外を投げたとき、SSE の error に例外文言が含まれない (5) 降格が起きた `/plan` の記録が降格後のモデル名 |
| 追加するテスト | `test_agents.py` にマスク後の記録。`test_main_api.py` に `/rank` の記録と error の文言。`test_planner.py` に `screen_agent` の記録。`test_usage_limits.py` に `note_call` |
| やらないこと | ai-engine が DB から plan を読む（Q5）。領収書読み取りの router 経由化。`OrchestateRequest` の改名。`ruff format` の全体適用 |

### チャンク 5: モバイルのナビ統一と設定・経理・エージェントの解放

| 項目 | 内容 |
|---|---|
| 目的 | スマホから契約と日常業務ができるようにする（D6） |
| 触るファイル | `apps/web/src/components/shell/navConfig.ts`、`MobileNav.tsx`、`AppShell.tsx`、`DesktopOnly.tsx`、`pages/SettingsPage.tsx`、`components/Settings/{BillingSection,UsageCard,MembersSection,IntegrationsSection}.tsx`、`pages/AccountingPage.tsx` と `components/Accounting/*`、`pages/AgentsPage.tsx`、`DESIGN.md` §4 |
| 実装の要点 | スマホ可否と下部タブを `navConfig.ts` の 1 つの表にし、`MobileNav` の `TABS` / `MOBILE_OK` を消す。完全一致と前方一致を表で持つ（`/agents` は可、`/agents/:id` は不可）。設定はスマホで 1 列（プラン・利用量・メンバーは表を縦積みの行に、連携は一覧と接続状態まで）。経理は工事一覧と下書きの承認まで。押せる要素は 44px 以上。横スクロールを出さない |
| 受け入れ条件 | (1) `isMobileRoute` が `/settings` `/accounting` `/agents` で true、`/agents/abc` `/governance` `/tasks` `/sales` `/analytics` `/sns` で false (2) `MobileNav.tsx` にルートの配列定義が無い (3) メニューの「スマホで使える」「パソコン向け」が同じ表から出る (4) `BillingSection` の押せる要素に `h-7` `w-7` が残らない (5) `check:tokens` 0 件 |
| 追加するテスト | `components/shell/__tests__/navConfig.test.ts`（全ルートの可否の表、`App.tsx` のルートと突き合わせ） |
| やらないこと | エージェント詳細のキャンバス、ガバナンス、タスク、営業、分析、SNS のスマホ対応。下部タブの入れ替え（4 つ＋メニューのまま）。新しい UI 部品の追加 |

### チャンク 6: PWA・認証画面・初回の案内

| 項目 | 内容 |
|---|---|
| 目的 | ホーム画面に置けて、登録から最初の操作まで迷わない |
| 触るファイル | `apps/web/index.html`、新規 `apps/web/public/manifest.webmanifest` とアイコン（192・512・maskable・apple-touch）、`vercel.json`（manifest のヘッダ）、`apps/web/nginx.conf`、`components/shell/AppShell.tsx`、`MobileNav.tsx`、`pages/{Register,Login,NoOrg,Invite}Page.tsx`、`pages/TopPage.tsx`、新規 `components/shell/Onboarding.tsx`、新規 `utils/onboarding.ts` |
| 実装の要点 | manifest（`display: standalone`、`start_url: /`、`theme_color` は既存の値、名前は「FLOW」）。viewport に `viewport-fit=cover`。`h-screen` を `100dvh` に。下部ナビと本文の下余白に `env(safe-area-inset-bottom)`。認証 4 画面は 360px 幅で崩れない 1 列、入力は 16px 以上（iOS の自動拡大を避ける）、`autocomplete` と `inputmode` を付ける。初回の案内は TOP の入力欄の下に 3 行（指示・連携・招待）。完了は既存 API から導出（チャット有無・連携有無・メンバー数）、閉じたら組織別の保存に記録して出さない |
| 受け入れ条件 | (1) ビルド成果物に manifest とアイコン 4 点があり、manifest が JSON として読め、参照先が全部存在する (2) `index.html` に manifest と apple-touch-icon のリンク (3) `onboardingSteps` が 3 項目の完了状態を正しく返し、全部完了か閉じた後は空 (4) web のソースに `h-screen` が残らない (5) TOP に KPI の数字を足していない（DESIGN.md §4） |
| 追加するテスト | `utils/__tests__/onboarding.test.ts`。`scripts/` に manifest とアイコンの存在検査を足し `npm test` から呼ぶ |
| やらないこと | service worker、オフライン、プッシュ通知（D7）。アイコンの本制作（仮のものを置き、O-8 で差し替え）。メール確認 |

### チャンク 7: セキュリティ（レート制限・登録の堅牢化・起動拒否・監査）

| 項目 | 内容 |
|---|---|
| 目的 | 公開して登録を受け付けられる最低線にする |
| 触るファイル | `apps/api-gateway/package.json`（`@fastify/rate-limit`）、`src/index.ts`、`config/env.ts`、`routes/auth.ts`、`routes/members.ts`、`routes/organizations.ts`、`routes/billing.ts`、`routes/integrations.ts`、新規 `services/audit.ts`、`packages/db-schema/prisma/schema.prisma` と新規マイグレーション（`AuditEvent`）、`tenancy/tenant-models.ts`、`routes/governance.ts`、`services/setup-status.ts`、`.env.example`、`render.yaml` |
| 実装の要点 | 制限: `/api/auth/login` と `/register` は IP ごと 10 回 / 分、招待の受諾とプレビューは 20 回 / 分、全体は 300 回 / 分。署名で守られた `/api/webhooks/stripe` と `/api/webhooks/line`、`/health` は除外。Render の背後なので `trustProxy` を設定する。429 は統一フォーマット。メールは登録・ログイン・招待で小文字化し前後空白を除く（既存行の重複は移行前に件数を確認する SQL を文書に書く）。本番（`NODE_ENV=production`）で n8n トークンが既定値なら起動時に例外。`/ready` は固定文言だけ返し、詳細はログへ。`index.ts` の `console.*` を logger に。`AuditEvent(orgId, actorId, action, targetType, targetId, meta, createdAt)` を足し、招待・役割変更・無効化・組織作成と改名・Checkout 開始・プラン変更・追加容量・連携の接続と切断で書く。閲覧は `GET /api/governance/audit`（管理者以上）。`INTERNAL_API_TOKEN` 未設定と `GEMINI_PAID_TIER=false` はセットアップ状況に「要対応」で出す |
| 受け入れ条件 | (1) ログインを同一 IP から 11 回続けると 11 回目が 429 で `{ success: false, error: { code: 'RATE_LIMITED' } }` (2) Stripe webhook は制限されない (3) `A@X.jp` で登録した後 `a@x.jp` でログインでき、同じメールの再登録は 409 (4) 本番で n8n トークン未設定なら起動関数が例外、開発では起動する (5) `/ready` の 503 応答に例外文言が無い (6) 役割変更で `AuditEvent` が 1 行でき、他組織の監査は見えない (7) 監査の meta に秘密の値が入らない |
| 追加するテスト | `tests/auth/rate-limit.test.ts`、`tests/auth/auth.route.test.ts`（正規化）、`src/config/__tests__/`（起動拒否）、`tests/governance/audit.test.ts`、`tests/tenancy/tenant-isolation.test.ts` に監査の行、`tenant-models` の突き合わせテストが通ること |
| やらないこと | パスワード再設定とメール確認（メール送信が要る。O-6）。2 要素認証。CAPTCHA。`INTERNAL_API_TOKEN` 未設定での起動拒否（既存の本番を止めうるので表示だけ）。監査画面の作り込み（表 1 つ） |

### チャンク 8: デプロイ再現性

| 項目 | 内容 |
|---|---|
| 目的 | `docker compose up --build` が鍵なしで起動し、Vercel・Render・Supabase の設定が互いに合う |
| 触るファイル | `docker-compose.yml`、`apps/api-gateway/Dockerfile`、`apps/web/Dockerfile`、`.dockerignore`、新規 `.node-version`、`package.json`（`engines`）、`render.yaml`、`vercel.json`、`.env.example`、`apps/api-gateway/src/config/env.ts`、`scripts/start-dev.sh`、新規 `scripts/check-deploy-config.mjs`、`.github/workflows/ci.yml`、`README.md` |
| 実装の要点 | compose: Postgres を `pgvector/pgvector:pg16` に。`env_file` を任意にし、開発用の既定値（`JWT_SECRET` など）を `environment` に置く（本番用でないことをコメントに書く）。n8n は `profiles: [n8n]` にして既定の起動から外す。gateway は `depends_on` で DB の健康を待ち、web は gateway の健康を待つ。Dockerfile は `node:22-alpine`。Render は `NODE_VERSION` と欠けた 3 キーを足す。`AI_ENGINE_URL` の既定値を `http://localhost:8000` に揃え、`AI_ENGINE_URL_COMPOSE` を消す。Vercel はリポジトリ側を正とし、プロジェクト側で直す設定を README に 1 表で書く。`start-dev.sh` の SQLite 処理を消す。照合スクリプト: `envSchema` のキーが `.env.example` にあること、`render.yaml` の gateway のキーが `envSchema` にあること、compose が YAML として読め pgvector のイメージであること、Dockerfile の Node が 22 以上であること。CI に compose のスモーク（起動 → `/health` と `/ready` → 登録 1 回）を足す |
| 受け入れ条件 | (1) `node scripts/check-deploy-config.mjs` が 0 で終わり、キーを 1 つ消すと失敗する (2) `.env` が無い状態で compose の設定が解決できる（箱に Docker が無いので、確認は CI のスモークジョブで行う。**ローカルでは未確認になる**ことをコミットメッセージに書く） (3) `config/env.ts` に `AI_ENGINE_URL_COMPOSE` が無い (4) リポジトリに `node:20` の記述が無い (5) README の手順が「clone → compose up → 登録」の 3 行で済む |
| 追加するテスト | `scripts/check-deploy-config.mjs` を `npm test` から呼ぶ。CI の `compose-smoke` ジョブ |
| やらないこと | 実際のデプロイ。Render のプラン変更。usage-metrics-svc の compose 追加。n8n ワークフローの作り直し。Vercel プロジェクト設定の変更（オーナー作業 O-4） |

### チャンク 9: 実 Postgres の統合テストと DoD の通しテスト

| 項目 | 内容 |
|---|---|
| 目的 | DoD を 1 本のテストで証明する。マイグレーションと raw SQL を本物の DB で確かめる |
| 触るファイル | 新規 `apps/api-gateway/tests/integration/`（`setup.ts`、`migrate.int.test.ts`、`dod-flow.int.test.ts`、`raw-sql.int.test.ts`）、`apps/api-gateway/vitest.integration.config.ts`、`apps/api-gateway/package.json`（`test:int`）、`package.json`、`.github/workflows/ci.yml`（`services: pgvector/pgvector:pg16`）、`README.md` |
| 実装の要点 | `TEST_DATABASE_URL` があるときだけ走る（無ければスキップし、`npm test` はシークレット無しで通るまま）。箱では apt で PostgreSQL と pgvector を入れる（`psql` は既にある。サーバとバージョンは未確認なので最初に確かめる）。テストごとにスキーマを作り直す。Stripe と ai-engine は偽物。通しの筋書き: A 社が登録 → B 社が登録 → A が B の id を引いても 404 → A がファイルを容量上限まで入れると次が拒否 → A が竹を契約（偽 webhook）→ 同じファイルが入る → A の AILog を上限まで積むと `/me/usage` が `over` → A のトライアルを過去にして未契約に戻すと書き込み 402 |
| 受け入れ条件 | (1) 空の DB に `prisma migrate deploy` が全部通る (2) 通しテストが実 DB で通る (3) `routes/files.ts` と `services/rag.ts` の raw SQL が他組織の行を返さない (4) `TEST_DATABASE_URL` 無しの `npm test` が従来どおり通る (5) CI に統合テストのジョブがある |
| 追加するテスト | 上の 3 ファイル |
| やらないこと | 偽 Prisma のテストの置き換え（残す）。ブラウザの E2E。負荷試験。ai-engine の統合テスト |

### チャンク 10: services の tenantDb 化

| 項目 | 内容 |
|---|---|
| 目的 | 素の prisma を使う場所を「組織をまたぐ必要がある所」だけにする |
| 触るファイル | `apps/api-gateway/src/services/{task-executor,capability-resolver,capability-executor,step-runner,rag,google-auth,integration-sync}.ts`、`services/adapters/index.ts`、`services/inbox/{draft-generator,line-inbox,receipt-capture}.ts`、`src/__tests__/architecture.test.ts`（allowlist を減らす）、呼び出し側のルート |
| 実装の要点 | 関数の引数で `TenantDb` を受けるか、`runAsTenant` の文脈から取る。組織が決まる前の逆引き（webhook の宛先解決、スケジューラの claim、取り残しの回収）だけ素の prisma に残し、理由を allowlist に書く。1 ファイルずつ直してテストを回す |
| 受け入れ条件 | (1) allowlist から 8 ファイル以上が消える (2) 残った各行に理由がある (3) 既存テストが全部通る (4) チャンク 9 の統合テストが通る |
| 追加するテスト | `tests/tenancy/tenant-isolation.test.ts` に services 経由の経路（エージェント実行、RAG 検索、LINE 受信）を足す |
| やらないこと | 挙動の変更。子モデルへの orgId 追加（Q7）。暗号文の orgId 束縛（Q8） |

### チャンク 11: RLS Phase 2a（opt-in）

| 項目 | 内容 |
|---|---|
| 目的 | アプリ層の強制が効かない 4 表（AILog・RiskEvent・FileChunk・MessageEmbedding）に DB 側の柵を用意する（D9） |
| 触るファイル | `docs/design/rls-phase2-draft.sql` → `packages/db-schema/rls/phase2a.sql`（マイグレーションには入れない）、`apps/api-gateway/src/tenancy/tenant-db.ts`、`routes/files.ts`、`services/rag.ts`、`config/env.ts`（`RLS_MODE`）、`apps/ai-engine/app/db.py` と `governance/{audit_logger,usage}.py`、`app/config.py`、`.env.example`、`tests/integration/rls.int.test.ts`、`docs/design/multi-tenancy.md` |
| 実装の要点 | `RLS_MODE=on` のとき、対象の読み書きを 1 トランザクションに包み、先頭で `set_config('app.org_id', <orgId>, true)` を呼ぶ（セッションスコープの SET は使わない）。統合テストでは `flow_app` ロールを作ってポリシーを当てて確かめる |
| 受け入れ条件 | (1) `flow_app` で `app.org_id` 未設定なら 4 表が 0 行 (2) A を設定すると A の行だけ見え、B の orgId での INSERT が拒否される (3) `RLS_MODE=off`（既定）で従来のテストが全部通る (4) `on` でチャンク 9 の通しテストが通る (5) 往復の増加を計測して設計書に数字を書く |
| 追加するテスト | `rls.int.test.ts`。ai-engine に `set_config` を呼ぶ単体テスト |
| やらないこと | 本番での有効化。残りのテナント表（Phase 2b）。Supabase のロール作成（O-5） |

### チャンク 12: 公開ページとドキュメントの整理

| 項目 | 内容 |
|---|---|
| 目的 | 売るのに要る頁を置き、手順書を 1 本にする |
| 触るファイル | 新規 `apps/web/src/pages/legal/{Terms,Privacy,Tokushoho}Page.tsx`、`App.tsx`、`pages/{Register,Login}Page.tsx`（リンク）、`components/Settings/BillingSection.tsx`（リンク）、`docs/DEPLOY.md`、`DEPLOYMENT_RUNBOOK.md`、`README.md`、`CLAUDE.md`、`docs/billing.md`、`docs/maintenance/cleanup-hold-list.md`、`docs/design/multi-tenancy.md` §14 |
| 実装の要点 | 法務の 3 頁は見出しと表だけの静的な頁で、事業者名・所在地・連絡先・登録番号などは空欄を明示する（文面はオーナーが入れる。O-7）。認証の外に置く。デプロイ手順は `docs/DEPLOY.md` に一本化し、`DEPLOYMENT_RUNBOOK.md` はそこへの案内だけにする。古い記述（Render 停止中、Neon）を消す。解決した既知の問題を hold-list から外す。この計画で採用した D1〜D9 を CLAUDE.md に反映する |
| 受け入れ条件 | (1) `/legal/terms` `/legal/privacy` `/legal/tokushoho` が未ログインで開ける (2) 登録画面と契約画面からリンクがある (3) デプロイ手順が 1 ファイルで、古い DB 名の記述が無い (4) hold-list の 1・2・3・4・5・7・8 と Node の追記が解決済みになっている |
| 追加するテスト | ルートの存在（`navConfig.test.ts` の突き合わせに足す） |
| やらないこと | 法務の文面の作成。マーケティング LP の変更。古い docs（MASTERY_GUIDE など）の書き直し |

### 時間が足りないときの切り方

| 残り時間 | やること |
|---|---|
| 十分 | 1 → 12 |
| 3 チャンクぶん不足 | 10・11 を落とす（12 は 30 分に縮めて文書だけ） |
| 半分 | 1・2・3・5・8・9。4・6・7 は次の晩 |

---

## 4. リスク

| リスク | 影響 | 手当て |
|---|---|---|
| D2 で既存の利用者を止める | 業務が止まる | `trialEndsAt = null` は止めない条件をテストで固定（チャンク 1 条件 4）。決済未設定では誰も止めない |
| Stripe の `trial_end` の下限が想定と違う | Checkout が失敗する | 実装前に公式文書で確認。満たさないときは付けない分岐を先に書く |
| 箱に Docker が無い | compose を手元で確かめられない | 静的な照合スクリプトと CI のスモークで代える。未確認であることを明記 |
| apt で pgvector が入らない | チャンク 9・11 が手元で走らない | CI の service で走らせる。手元は Postgres だけで走る部分とそうでない部分を分ける |
| メールの小文字化で既存行が衝突 | ログインできない人が出る | 移行前に件数を数える SQL を文書に置き、衝突があれば止めてオーナーに返す |
| レート制限が Render の背後で全員を同一 IP と見なす | 正常な利用者が 429 | `trustProxy` を設定し、転送ヘッダから IP を取るテストを置く |
| スマホ画面を実機で見ていない | 崩れに気づかない | 判定は純粋関数のテストで固定。見た目はオーナー確認（O-10） |

---

## 5. オーナーにお願い

| # | お願い | いつ要るか | 無いとどうなるか |
|---|---|---|---|
| O-1 | Stripe アカウント（テストモード）のシークレットキー。手元で `npm run stripe:bootstrap -- --apply` を 1 回流し、出てきた値を Render に入れる | チャンク 3 の後 | 設定 > プランが「準備中」のまま。D2 の期限切れも発動しない |
| O-2 | Stripe の本番申請（事業者情報、適格請求書の登録番号、請求書への表示） | 有償販売の前 | 本番で課金できない |
| O-3 | Render の環境変数: `N8N_WEBHOOK_AUTH_TOKEN`（独自の値）、`INTERNAL_API_TOKEN`（gateway と ai-engine に同じ値）、`ALLOWED_ORIGIN_HOSTS`、`APP_BASE_URL`、`JWT_SECRET`（32 文字以上） | チャンク 7・8 をデプロイする前 | n8n トークンが既定値だと本番の gateway が起動しない（採用済みの判断） |
| O-4 | Vercel プロジェクトの設定を `vercel.json` に合わせる（rootDirectory を空に、または README の表のとおり）。独自ドメインを使うなら DNS | デプロイ時 | prebuilt でしかデプロイできない状態が続く |
| O-5 | Supabase: 本番 DB の接続先と `SUPABASE_SERVICE_ROLE_KEY` の確認、非公開バケット `org-files`。RLS を有効にするなら `flow_app` / `flow_system` ロールの作成と `rolbypassrls` の確認 | デプロイ時。RLS はチャンク 11 の後 | ファイルが再デプロイで消える。RLS は off のまま |
| O-6 | メール送信サービスの契約と送信ドメイン（SPF・DKIM） | パスワード再設定・メール確認・招待メール・トライアル終了通知を作るとき | パスワードを忘れた人を救えない。今回は対象外にしてある |
| O-7 | 利用規約・プライバシーポリシー・特定商取引法に基づく表記の文面と、事業者名・所在地・連絡先 | 公開の前 | 法務の 3 頁が空欄のまま |
| O-8 | アプリのアイコン（512px の正方形 1 枚でよい）と、ホーム画面に出す名前 | チャンク 6 の後 | 仮のアイコンのまま |
| O-9 | 判断の確認: (a) D1・D2 でよいか (b) 既存の組織をいつトライアルに乗せるか、乗せないか (c) D4（2 つ目以降の組織は契約するまで閲覧のみ）でよいか、PR #7 の「梅の上限で使える」に戻すか (d) トライアル中の上限は梅でよいか | チャンク 1 の前が望ましい。無ければ表の既定で進める | 既定のまま実装される |
| O-10 | スマホ実機（iPhone と Android を 1 台ずつ）での確認: 登録 → チャット → 設定 > プラン → Checkout → 戻り | チャンク 5・6 の後 | 見た目の崩れが残りうる |
| O-11 | Gemini の有料課金への切り替えと `GEMINI_PAID_TIER=true`。Anthropic の利用上限の確認 | 有償の顧客を乗せる前 | 梅・竹の入力が Google の製品改善に使われうる（`docs/pricing/README.md` の 2） |
| O-12 | Render の有料プランの継続と、n8n を本番で使うかどうかの判断 | デプロイ時 | n8n 無しでも ai-engine のフォールバックで動く |
| O-13 | PR #7 設計書 §14 の残り（Q1・Q2・Q6）の確認 | 急がない | 仮採用のまま |

---

## 6. チャンク一覧

| # | タイトル | 受け入れ条件（1 行） |
|---|---|---|
| 1 | 登録時トライアルと期限切れの閲覧のみ化 | 登録 31 日後・未契約・決済設定済みのときだけ書き込みが 402、既存組織は止まらない |
| 2 | web の契約状態・上限・402 の導線 | `planNoticeOf` が 7 状態を返し、402 と容量超過から契約画面へ行ける |
| 3 | Stripe テストモード一式 | 偽 Stripe で 登録 → 契約 → 上限拡大 → 解約 → 402 → 再契約 が 1 本で通る |
| 4 | 利用量の計測を正す | `/rank` と `screen_agent` が回数に入り、AILog とエラーに生の入力・例外文言が出ない |
| 5 | モバイルのナビ統一と設定・経理・エージェントの解放 | スマホ可否が 1 つの表から出て、`/settings` がスマホで開く |
| 6 | PWA・認証画面・初回の案内 | manifest とアイコンがビルドに入り、初回の 3 行が完了で消える |
| 7 | セキュリティ | ログイン 11 回目が 429、本番で n8n トークン既定値なら起動拒否、管理操作が監査に残る |
| 8 | デプロイ再現性 | 設定の照合スクリプトが通り、CI で compose が `.env` 無しで起動して登録まで通る |
| 9 | 実 Postgres の統合テストと DoD の通し | 2 社の登録から上限・契約・402 までが実 DB で通る |
| 10 | services の tenantDb 化 | 素の prisma の allowlist が 8 ファイル以上減る |
| 11 | RLS Phase 2a（opt-in） | `flow_app` ロールで他組織の 4 表が 0 行、既定 off で従来どおり |
| 12 | 公開ページとドキュメントの整理 | 法務 3 頁が未ログインで開き、デプロイ手順が 1 ファイル |

---

## 7. 実行時の決定（2026-11-17 夜、オーケストレーター）

| 論点 | 決定 |
|---|---|
| D1/D2 登録時トライアル＋切れたら閲覧のみ | 採用（マネタイズの前提。既存組織 `trialEndsAt = null` は止めない） |
| D4 作成者の2つ目以降の組織 | 採用（「トライアルは作成者ごとに1回」「1ユーザー10組織」は PR #7 の値のまま。無料の抜け道を塞ぐため、2つ目以降は契約するまで閲覧のみ） |
| 既存組織をトライアルに乗せるか | 乗せない（SQL を文書に置くだけ） |
| ローカル統合テストの DB | 箱に Docker が無いので PostgreSQL 16 + pgvector 0.6.2 のバイナリを箱で起動（port 55432）。CI は `pgvector/pgvector:pg16` サービス |
| チャンク 1 の 402 の時刻 | 登録時トライアルの期限切れは要求時刻で判定し、所属キャッシュ（30 秒）には `trialEndsAt` の値だけを載せる。期限ちょうど（`trialEndsAt == now`）は閲覧のみ側に倒す |
| チャンク 1 の D4 の数え方 | 「自分で作った組織が既に 1 つ以上ある（`createdBy` で数える）」なら 2 つ目以降とみなし `trialEndsAt = 作成時刻`。招待で入っただけの人の最初の組織にはトライアルを付ける |
| チャンク 1 の決済未設定の判定 | `STRIPE_SECRET_KEY` の有無だけで見る（`config.billingConfigured`）。price が欠けていても止める側（Checkout は 400 で案内できるため） |
| チャンク 2 の帯の優先順 | `expired > trial > storage-over > ai-over > storage-warn > ai-warn`。止まっているもの → 止まりそうなもの（課金の機会）→ 品質が落ちているもの → 近づいているもの。帯は常に 1 つだけ |
| チャンク 2 の 402 の受け方 | interceptor は組織 id 付きの印（メモリのみ）を付けて例外を投げ直すだけ。帯はその後に取り直した `GET /api/billing` を正とする（再読み込み・組織切替で消える）。`402` の判定はコードを見ず status だけ（gateway は 402 を閲覧のみにしか使わない） |
| チャンク 2 の Checkout の文言 | 登録時トライアル中の Checkout は現状その日から課金されるので「ご契約の日から料金がかかります」と書く。D3（残り期間の引き継ぎ）をチャンク 3 で入れたら文言も直す |
| チャンク 2 のスマホからの導線 | 帯はスマホにも出るが、`/settings` のスマホ解放はチャンク 5（D6）。それまでスマホで「プラン」を押すと「パソコンで開いてください」になる |
| チャンク 3 の D3（残り期間の引き継ぎ） | Stripe 公式（Create a Checkout Session、2026-11 確認）で `trial_end` は「48 時間以上先」。余裕 1 時間を見て残り 49 時間未満なら付けない。`trial_period_days` とは同時に送らない。**一度でも契約した組織（`subscriptionStatus` が入っている）には付けない**（解約 → 再契約で同じ無料期間を使い直させない） |
| チャンク 3 の「決済設定済み」 | オーケストレーター追記どおり `STRIPE_SECRET_KEY` と `STRIPE_PRICE_STARTER_MONTHLY` の両方で判定（`config.billingConfigured`）。既存テストのうちキーだけで 402 を期待していたもの（entitlement / auth-switch）は price も入れる形に書き換えた |
| チャンク 3 の bootstrap | 価格は `lookup_key`、商品・税率は metadata で既存を探す。ポータルは既定の設定を更新（無ければ作り、既定化はダッシュボードで確認と警告）。webhook の署名鍵は作成時だけ出す。`node --test` はルートの `npm test` から `test:scripts` で回す |
| チャンク 4 の note_call | `note_call` は既に `LLMRouter.chat` / `chat_stream` の1か所で呼ばれているので、`/rank` と `screen_agent` には**足さない**（足すと二重に数える）。足したのは AILog の記録だけ。「1 回で 1 だけ進む」をテストで固定 |
| チャンク 4 の記録の時点 | `/rank` は応答の解析より先に記録する（壊れた応答でも呼び出しは発生しているため）。LLM 呼び出し自体が失敗したときは `/rank`・`screen_agent` とも記録しない（`note_call` も進まないのと揃える） |
| チャンク 4 の `/plan` の model | `plan_capability_with_model` で応答の実モデル名を受け取って記録。応答が無い（ケイパビリティ 0 件・呼び出し失敗）ときだけ事前に決めたモデル名で埋める（従来どおり 1 行記録） |
| チャンク 4 のエラー応答 | `/orchestrate` は鍵未設定 503・それ以外 502、`/orchestrate/stream` は SSE の error。いずれも固定文言（`ERROR_AI_NOT_CONFIGURED` / `ERROR_AI_FAILED`）で、詳細は `logger.exception` のみ。以前の「RuntimeError 以外は投げ直し（500）」のテストは意図が変わったので 502 の固定文言に書き換えた。gateway は status と本文を見ずに扱うので影響なし |
| チャンク 4 の DATABASE_URL | 既定値（SQLite）は変えず、`settings.database_url_configured` が偽なら起動時に警告するだけ（`test_config.py` の既定値の固定はそのまま） |
| チャンク 5 の表の形 | `MAIN_NAV` / `WORK_PAGES` / `ADMIN_NAV` の各行に `mobile: 'exact' \| 'prefix' \| false` と `tab` を持たせ、`NAV_ROUTES`（3 つの連結）から `MOBILE_TABS`・`MOBILE_MENU`・`DESKTOP_MENU`・`isMobileRoute` を出す。前方一致は区切り単位（`/chatroom` は `/chat` に含めない）。`/dashboard` は従来どおりパソコン向けのまま（D6 に無いため） |
| チャンク 5 の 44px | 画面ごとに足すと漏れるので、`Button` に `max-lg:min-h-11`（アイコンだけなら幅も）、`LiquidTabs` に `max-lg:h-11` を内蔵した。PC の見た目は変わらない。スマホではチャット等の既存画面のボタンも 44px になる（DESIGN.md §5 に追記） |
| チャンク 5 のスマホの範囲 | 設定の連携はスマホでは一覧と接続状態まで（トークン貼り付け・Google の接続開始はパソコン）。経理の「取引先・インボイス」タブはスマホでは `DesktopOnly`。工事と原価の追加フォームは残す（縦積みで入力できるため）。エージェントの作成はスマホでも残す（モーダルが 1 列のため。詳細 `/agents/:id` はパソコン） |
| チャンク 5 のプラン表 | 「カードの入れ子禁止」に合わせ、3 プランの枠（角丸・枠線・塗り）を区切り線に置き換えた（スマホは縦積みの行、md 以上は 3 列）。「ご契約中」はボタンの文言で示す |
| チャンク 6 の案内の行と完了 | 行は権限で絞る（OWNER=指示・連携・招待 / ADMIN=指示・連携 / MEMBER=指示）。押して 403 になる行は出さない。完了: 指示=チャットのセッションが組織に 1 件以上、連携=`/api/integrations` に CONNECTED があるか LINE 接続がある（LINE の一覧はオーナーだけ読めるので ADMIN は Slack/Google だけで判定）、招待=ACTIVE が 2 人以上か保留中の招待がある（送った時点で完了）。読み込み中・取得失敗は何も出さない（完了済みの行がちらつかないように） |
| チャンク 6 の「閉じた」記録 | `localStorage` の `flow.onboarding.dismissed.<orgId>`（組織ごと・端末ごと）。サーバの列は足さない。別の端末では再び出るが、完了すれば自動で消えるので害は小さい |
| チャンク 6 の 16px | 認証 4 画面だけでなく `Input` 部品に `max-lg:text-base` を内蔵（PC の見た目は不変）。スマホで使う素の入力欄（TOP の指示、チャットの入力）にも付けた |
| チャンク 6 のアイコン | 仮アイコンは `apps/web/scripts/generate-icons.mjs`（依存ゼロ、#635bff に白の F）で生成してコミット。O-8 で同名・同寸法のファイルに差し替えるだけ。manifest は Vercel・nginx とも `application/manifest+json` で毎回再検証、`/icons/` は 1 日キャッシュ |
| チャンク 6 の検査の置き場所 | 検査本体は `apps/web/scripts/check-pwa.mjs`（manifest の JSON・必須項目・アイコンの PNG 実寸・index.html のリンクと参照先・viewport-fit）。web の `build` の最後に `dist` に対して回し、ルートの `npm test`（`test:scripts`）でソースと新しい `dist` に対して回す |
| チャンク 7 の trustProxy | `true`（全段を信じる）にせず段数 `TRUST_PROXY_HOPS`（既定 1 = Render の LB）。利用者が `X-Forwarded-For` の先頭を書いてもすり抜けられないことをテストで固定。全員 429 になったら段数のずれを疑う（`docs/security.md`） |
| チャンク 7 の 429 の本文 | `@fastify/rate-limit` の仕組み上 `statusCode: 429` が本文に 1 つ余分に付く。`success` と `error.code` は統一フォーマットのまま。制限の除外は 1 か所（`isRateLimitExempt`）に置き、ルートに `rateLimit: false` は書かない |
| チャンク 7 のメールの既存行 | 移行で小文字にするが、小文字にすると別の行と衝突する行は触らない（migrate を失敗させてデプロイを止めないため）。件数を数える SQL は `docs/security.md` |
| チャンク 7 の監査の書き方 | 組織の作成と招待の受諾は同じトランザクションで書く。それ以外は操作の後に書き、失敗しても操作は成功させる（記録の不調で契約・招待を止めない）。meta は秘密らしいキー名の値を落とす |
| チャンク 7 の監査の範囲 | 計画の項目に加え、招待の取り消し・招待の受諾（`member.join`）・LINE の接続と切断も記録する。プラン変更は Stripe を実際に更新したときだけ（同じ price なら記録しない） |
| チャンク 7 のセットアップ状況 | `INTERNAL_API_TOKEN` 未設定は ai-engine に届かなくても「要対応」（以前は「確認できず」で隠れていた。既存テストを意図の変更として書き換えた）。`GEMINI_PAID_TIER` は gateway にも同じ値を入れる前提で「要対応」を出す（render.yaml は既に両方にある） |
| チャンク 8 の compose の NODE_ENV | 既定は `development`（`.env` で上書き可）。production にすると n8n の独自トークンが必須になり「鍵なしで一発起動」と両立しないため。compose は開発・確認用で、本番は render.yaml |
| チャンク 8 の公開された JWT_SECRET | compose の開発用既定値と `.env.example` の見本値を `PUBLIC_JWT_SECRETS`（`startup-checks.ts`）に載せ、**本番ではこの値だと起動拒否**（新規）。照合スクリプトが compose・`.env.example` と表を突き合わせる |
| チャンク 8 の usage-metrics-svc | 「やらないこと」と追記（取り込む）が食い違うので、`--profile metrics` の任意起動にした（既定の起動・スモークには入れない）。n8n も `--profile n8n`、タグは `2.15.0` 固定（SQLite の volume のまま。render.yaml の n8n は O-12 なので触らない） |
| チャンク 8 の公開ポート | 外に出すのは web（3000）だけ。postgres・gateway・ai-engine・n8n・metrics は `127.0.0.1` に限定（ai-engine を LAN に出さない）。Postgres の volume は `pgdata16`（旧 alpine の `pgdata` と混ぜない） |
| チャンク 8 の render.yaml の整理 | gateway から `ANTHROPIC_API_KEY`（gateway は読まない＝鍵を置く場所を減らす）と `N8N_WORKFLOW_ID`（どこも読まない）を外した。照合スクリプトは「宣言したキーは読み口にある」を gateway・ai-engine の両方で検査し、Render 基盤のキーは `PLATFORM_KEYS`（今は `NODE_VERSION` だけ） |
| チャンク 8 の YAML の読み方 | ルートの devDependency に `yaml`（依存ゼロ）を足した。自前の簡易パーサは anchors 等で誤判定するため |
| チャンク 8 の compose の確認 | 箱に Docker が無いので **ローカルでは未確認**。CI の `compose-smoke`（`.env` 無し → `--wait` → `/health`・`/ready` → web の nginx 経由で登録 201）で確かめる |
| チャンク 9 の DB の作り直し | スキーマ単位ではなく**テストファイルごとにデータベース**（`<TEST_DATABASE_URL の DB 名>_<乱数>`）を作り、`migrate deploy` → 終了時に `DROP … WITH (FORCE)`。拡張 vector はデータベース単位で、スキーマを分けると型が見えない／消すと拡張ごと消えるため。DB 名は `flow_` で始まるものだけ受け付ける（共有の Postgres で他人の DB に触らない）。ファイル内のテスト間は `TRUNCATE` |
| チャンク 9 の npm test との関係 | 統合テストは `npm run test:int`（gateway の `vitest.integration.config.mts`）だけで回す。`vitest.config.mts` で `tests/integration/**` を除外し、`TEST_DATABASE_URL` が手元にあっても `npm test` は DB に触らない。CI の integration ジョブは `REQUIRE_TEST_DATABASE=1` で「全部スキップで緑」を失敗にする。設定ファイルは CommonJS のパッケージなので `.mts` |
| チャンク 9 の容量上限の再現 | 1GB を実際に送らず、1 件目は実アップロード（カウンタが行と同じトランザクションで増えることを確認）→ カウンタを上限の 1MB 手前に進めて 2MB を拒否 → 竹で同じ 2MB が入る。分離は B のファイルの GET / DELETE が 404 と一覧で確かめる。通しの app は `index.ts`（起動してしまう）ではなく必要なルートだけを本物で組む |
| チャンク 9 で見つけたずれ | `UploadedFile_orgId_idx`（20260913 のマイグレーション）が schema.prisma に無く、`migrate dev` すると DROP が生成される状態だった。schema に `@@index([orgId])` を足した（DB は変わらない＝マイグレーション不要）。pgvector の HNSW 索引 2 つは Prisma で書けないので、ずれ検査で許す表に理由付きで置いた |

> オーケストレーター追記（チャンク 3 で対応）: 「決済設定済み」の判定は `STRIPE_SECRET_KEY` だけでなく、梅の月額価格 ID（`STRIPE_PRICE_STARTER_MONTHLY`）もあるときに限る。キーだけ入れて価格が無いと、期限切れ組織が閲覧のみになり契約もできない詰みになるため。

> オーケストレーター追記（FLOW エージェントからの引き継ぎ）:
> - チャンク 4: `/rank` に加えて `screen_agent` も AILog と月間上限に数える（PII マスク後の値だけ記録）。
> - チャンク 8: Render を使わないローカル完結案の下書きが `/workspace/org-ai-platform-render-research/local-render-alt/`（REPORT.md、docker-compose.local.yml、Caddyfile、cloudflared/、init-postgres.sql、up.sh、verify.sh、env.local.example）にある。これを読み、pgvector compose・ヘルスチェック（runtime に curl が無い問題）・`VITE_WS_URL` の扱い・n8n タグ固定・usage-metrics-svc を取り込む。秘密は入れない。`AI_ENGINE_URL` 既定値の不一致もここで直す。
> - チャンク 10: task-executor・rag・inbox を優先して tenantDb 化。所属確認の 30 秒キャッシュは維持。
> - 削除保留は `docs/maintenance/cleanup-hold-list.md`、テナント設計は `docs/design/multi-tenancy.md` が正本。
