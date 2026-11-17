# SaaS 化 12 チャンクのレビュー（`aec4299..HEAD`）

**一行要約: 登録 → テナント → 上限 → 契約の本線は通り、既存組織と決済未設定の環境も止まらないが、「閲覧のみ」が認証付きの経路にしか効いておらず期限切れ後も定期実行と LINE 受信で AI が動き続ける（高 1 件）。ほかに、契約まわりの詰み 2 件と未確認 2 件（中 4 件）を直してから出すのがよい。**

- 対象: `git diff aec4299..HEAD`（26 コミット・169 ファイル）。計画は `docs/plan/saas-readiness-plan.md`。
- 方法: 差分と周辺コードの読解のみ。コードは変更していない。
- ⚠️ **テストは実行していない**（このセッションでは `npm test` / `npm run typecheck` の実行が許可されなかった）。「通る」と書いた箇所はコードとテストコードを読んだ判断で、実行結果ではない。
- スマホの見た目はコードからの推測（実機確認は計画書 O-10 のまま）。

## 1. 指摘

| # | 重大度 | 観点 | ファイル:行 | 指摘 | 根拠 | 修正案 |
|---|---|---|---|---|---|---|
| 1 | **高** | DoD（無料の抜け道） | `apps/api-gateway/src/services/schedule-dispatcher.ts:183`、`routes/inbox/line-webhook.ts:77`（→ `services/inbox/line-inbox.ts:139`）、`routes/webhooks.ts:203` | 期限切れ・解約済み（閲覧のみ）の組織でも、定期実行・LINE 受信（下書き生成・領収書の読み取り）・n8n からの enqueue が動き続ける | 契約の判定（`entitlementDecision`）を呼ぶのは `middleware/auth.ts` の `requireAuth` だけ。`src` 内で entitlement を参照するのは auth / billing / organizations のみで、認証の無い 3 経路は見ていない。トライアル中に定期実行を仕込めば、期限後も契約せずに AI が回り続け、費用はこちら持ちになる | 3 経路の入口で組織の `subscriptionStatus` / `trialEndsAt` を一緒に読み、`entitlementDecision` が `read_only` なら実行せずスキップ（定期実行は `lastRunAt` を進めず、LINE は受信メッセージの保存だけ残して AI 処理を止める）。判定は今の関数をそのまま使う。テストは「期限切れの組織の ScheduledTask が発火しない」「LINE の画像で `/vision/receipt` を呼ばない」 |
| 2 | 中 | DoD（詰み） | `apps/api-gateway/src/config/env.ts:347`、`routes/billing.ts:167-` | `STRIPE_WEBHOOK_SECRET` が無くても「決済設定済み」になり、Checkout も作れる。支払ったのに組織へ反映されず、閲覧のみのまま | `billingConfigured` はキーと梅の月額 price だけを見る。webhook は鍵が無いと 503 で全部落とす（`routes/billing-webhook.ts:29`）。Checkout から戻った画面で取り直す経路は無く、写し込みは webhook だけ。セットアップ状況は `warn` を出すが止めない | `billingConfigured` に webhook の署名鍵を含める（3 つそろって初めて期限切れを止める）。あわせて `/checkout` は鍵が無ければ 503 `BILLING_NOT_CONFIGURED` を返す。`check:deploy` と env.test に 1 行ずつ |
| 3 | 中 | セキュリティ（レート制限） | `apps/api-gateway/src/index.ts:48`、`render.yaml`（`TRUST_PROXY_HOPS=1`） | Render の実際の `X-Forwarded-For` の並びを確かめた記録が無い。段数が合っていなければ、全利用者が同じ IP に見える（ログイン 10 回/分を全員で共有 = ログインできない）か、逆にヘッダの書き換えですり抜けられる | テスト（`tests/auth/rate-limit.test.ts`）は「XFF の最後の値で数える」ことを確かめているだけで、Render がそこに何を入れるかは仮定。Render は前段に CDN を挟むので 1 段とは限らない。`docs/security.md` も「全員が 429 なら段数を疑う」という事後対応のみ | デプロイ直後に 2 つの回線から叩き、`[rate-limit]` ログの `ip=` が回線ごとに違うことを確認する手順を `docs/DEPLOY.md` の確認項目に足す。合わなければ `TRUST_PROXY_HOPS` を実際の段数にする。確認が済むまでログインの上限は緩め（例 30/分）にしておくのが安全 |
| 4 | 中 | DoD（詰み寄り）・文言 | `apps/api-gateway/src/services/entitlement.ts:46`、`services/billing/sync.ts:39` | Stripe の状態が 1 度でも入ると登録時トライアルの残りが無視される。`incomplete`（カード認証の失敗）や、試しに契約してすぐ解約した `canceled` で、無料期間が残っていても即「閲覧のみ」になる | `if (status)` が先に評価され、`trialEndsAt` を見ない。`applySubscription` は `incomplete` もそのまま写す。残り 49 時間未満の組織は即課金の Checkout になるので、3D セキュア失敗で残りの無料期間を失い、文言も「ご契約が終了」になる。再契約はできるので完全な詰みではない | `incomplete` / `incomplete_expired` は「未契約」と同じ扱い（null と同じ分岐に落とす）にする。解約後の残り期間は仕様として決め（現状のままなら billing.md に明記）、`entitlement.test.ts` に状態ごとの表を足す |
| 5 | 中 | テストの質 | `apps/api-gateway/tests/integration/dod-flow.int.test.ts:31,61,157-174`、`tests/helpers/fake-stripe.ts`、`apps/web/src/components/shell/__tests__/*.source.test.ts` | DoD の「支払い（Stripe test）」「プラン上限」「スマホ」は、いずれも本物を通していない | (a) Stripe はメモリ内の偽物で、実テストモードの Checkout → webhook → 反映は 1 度も流れていない（`trial_end` を含むフォームの符号化を Stripe が受け付けるかは未検証）。(b) AI の上限は gateway の表示（`/me/usage` が `over`）だけで、ai-engine が実際に軽いモデルへ落とすことは通しで見ていない。(c) 統合用アプリ（`tests/integration/app.ts`）は `index.ts` の配線（レート制限・起動チェック・trustProxy）を通らない。(d) web の `*.source.test.ts` はソースの正規表現一致で、描画していない（390px の崩れは検出できない） | (a) O-1 の後、`npm run stripe:bootstrap` → 実 Checkout（テストカード）→ webhook → 設定 > プラン の反映を 1 回通し、手順と結果を `docs/billing.md` に残す。(b) ai-engine に「上限超過の組織で `/llm/chat` の応答モデルが軽いモデルになる」テストがあるか確認し、無ければ足す。(c) `index.ts` の組み立てを関数に出して統合テストから使う。(d) は O-10 の実機確認で補う |
| 6 | 低 | DoD（無料の抜け道） | `apps/api-gateway/src/routes/auth.ts:62` | メール確認が無いので、別のメールで登録し直せば 30 日のトライアルを何度でも取れる（D4 が塞ぐのは同じユーザーの 2 つ目だけ）。エージェント構築は全員 Opus なので原価も乗る | 登録は常に `appTrialEndFrom(now, days)`。歯止めは IP ごと 10 回/分だけ | メール送信（O-6）が入るまでは既知の制約として `docs/billing.md` に書く。入ったらメール確認後にトライアル開始 |
| 7 | 低 | DoD（無料の抜け道） | `apps/api-gateway/src/services/billing/billing-core.ts:201-`、`routes/billing.ts:214-` | 登録時トライアル中に松で Checkout すると、無料期間の残りを松（Claude）の上限で使え、課金前に解約できる（D5「トライアル中は梅」と食い違う） | `trial_end` を引き継ぐと `trialing` になり、`subscriptionSnapshot` は entitled ならその price のプランを写す | カードは要るので許容範囲。仕様として billing.md に 1 行。厳しくするなら trialing の間は上限を梅に据え置く |
| 8 | 低 | DoD | `apps/api-gateway/src/services/organizations.ts:60` | 2 つ目の組織の判定が「数えてから作る」なので、同時に 2 回押すと両方にトライアルが付きうる | `count` と `create` の間にロックが無い。登録で作った人は既に 1 つあるので、影響するのは招待で入った人の初回だけ | 実害は小さい。直すなら作成者の行を `SELECT … FOR UPDATE` するか、作成後に数え直して 2 つ以上なら期限を now に戻す |
| 9 | 低 | 既存挙動 | `packages/db-schema/prisma/migrations/20261120000200_*/migration.sql`（小文字化の UPDATE） | 大文字小文字だけ違うメールが 2 行ある既存ユーザーは、片方がログインできなくなる | 衝突する行は意図的に触らない。ログインは小文字で引くので、大文字入りのまま残った行に一致しない | 手順（デプロイ前の件数確認 SQL）は `docs/security.md` にある。`docs/DEPLOY.md` のデプロイ前チェックにも同じ SQL を載せ、0 行を確認してから流す |
| 10 | 低 | セキュリティ（レート制限） | `apps/api-gateway/src/middleware/rate-limit.ts:29,52` | (a) ログインの制限は IP 単位だけで、アカウント単位の試行制限が無い。(b) `/api/webhooks/line` は署名の検証前から無制限（検証のたびに DB を引く）。(c) n8n のコールバックと、同じ回線の事務所の全員が全体 300 回/分を共有する | (a)(b) は実装どおり。(c) n8n は 1 つの IP から task-log を連続で送る | (a) はメール単位の失敗回数（メモリで可）を足す。(b) は未署名の要求だけ数える。(c) は運用で 429 のログを見て上限を調整 |
| 11 | 低 | 既存挙動（本番起動拒否） | `apps/api-gateway/src/config/startup-checks.ts:44` | n8n を使わない構成でも `N8N_WEBHOOK_AUTH_TOKEN` が無いと本番の gateway は起動しない。O-3 の前にデプロイすると新しい版が上がらない | 採用済みの判断（計画書 O-3）。開発と compose は `NODE_ENV=development` 既定なので壊れていない（`docker-compose.yml` の `NODE_ENV: ${NODE_ENV:-development}`、CI の compose-smoke が `.env` 無しで起動 → 登録まで確認） | 問題なし。`docs/DEPLOY.md` の先頭の「先に入れる環境変数」に入っていることだけ確認 |
| 12 | 低 | 設定 | `apps/api-gateway/src/config/env.ts:352-` | `BILLING_TRIAL_DAYS=0` にすると、登録した瞬間から閲覧のみになる（初回の指示も保存できない） | `n >= 0` を許し、`trialEndsAt = now` になる | 0 は「トライアル無し = 期限を付けない」か、下限 1 にするかを決めて固定 |
| 13 | 低 | UI（スマホ） | `apps/web/src/components/Accounting/VendorInvoice.tsx:297-299`、`pages/AccountingPage.tsx:30` | スマホで開けるようにした経理のうち、「取引先・インボイス」だけ表のまま（カード内の横スクロール）。タブ名も一語でない | 原価・工事台帳は `hidden … lg:block` の表とスマホ用の一覧に分けたが、VendorInvoice は差分に入っていない。ページ全体の横スクロールにはならない（`overflow-x-auto` の内側） | 他の 2 つと同じくスマホは区切り線の一覧にする。タブ名は「取引先」 |
| 14 | 低 | UI | `apps/web/src/components/shell/PlanNotice.tsx:61` | 帯の「プラン」リンクはメンバーにも出るが、契約できるのはオーナーだけ | 役割を見ていない。押した先で操作できない | メンバーにはリンクを出さず、文言を「オーナーにご連絡ください」に替える（1 文のまま） |
| 15 | 低 | デプロイ再現性 | `docker-compose.yml`（`env_file: - path: .env / required: false`） | この書き方は Docker Compose v2.24 以降が要る。古い版では `.env` 無しの起動以前に設定の解釈で落ちる | Compose の仕様。CI のランナーは新しいので通る | README「最短で動かす」に必要な版を 1 行 |

## 2. 確認して問題が無かったもの

| 観点 | 確認した内容 |
|---|---|
| 既存組織が止まらない | `trialEndsAt = null` かつ未契約は `full`（`entitlement.ts:52`）。`entitlement.test.ts` の (4) で固定。`applySubscription` は入っている `trialEndsAt` を消さない |
| 決済未設定で止まらない | `billingConfigured = false` なら期限切れでも `full`。キーだけで梅の price が無い場合も止めない（閉じ込め防止。テストあり） |
| 再開の経路 | `/api/billing` `/api/auth` `/api/webhooks` は閲覧のみでも通る。期限切れ後の Checkout は 200（DoD の通しテストで確認する作り） |
| webhook 署名 | raw body に対する HMAC、時刻の許容 300 秒、`timingSafeEqual`、処理に成功してから処理済みの印、毎回サブスクリプションを取り直す。顧客 ID の取り違えも弾く |
| テナント越境 | 新しい経路（監査の閲覧、LINE・定期実行・RAG の tenantDb 化）は `authOf(request).db` / `tenantDb(orgId)`。監査の操作者名はその組織の所属から引く。raw SQL は `"orgId"` 条件付きのまま |
| 秘密・PII | 監査の `meta` は秘密らしいキーを落とす。招待トークンは監査にもログにも入れない。`/ready` と ai-engine のエラーは固定文言。AILog の入力はマスク後。起動拒否のメッセージに値を入れない |
| RLS | 既定 off で従来と同じ経路。`SET` は使わず `set_config(…, true)` のみ |
| compose | `.env` 無しで起動できる作り（開発用の既定値、`NODE_ENV=development`、公開ポートは web だけ）。公開されている JWT_SECRET は本番で起動拒否 |
| UI | 新しい部品（PlanNotice・Onboarding・法務の頁・プラン表）は白地と区切り線だけで、色付きの左バー・影・カードの入れ子は無い。リンクは「プラン」の一語。`h-screen` は残っていない。タップ領域は 44px |

## 3. 修正すべきもの（高・中）

- **[高] #1** 期限切れ・解約済みの組織の定期実行、LINE 受信の AI 処理、n8n からの enqueue を止める（`schedule-dispatcher.ts:183`、`line-webhook.ts:77`、`webhooks.ts:203`）。
- **[中] #2** `STRIPE_WEBHOOK_SECRET` が無いときは「決済設定済み」にせず、Checkout も作らせない（`env.ts:347`、`routes/billing.ts`）。
- **[中] #3** Render の実際の `X-Forwarded-For` で `TRUST_PROXY_HOPS=1` が正しいかをデプロイ直後に確認し、手順を `docs/DEPLOY.md` に足す（`index.ts:48`）。
- **[中] #4** `incomplete` / `incomplete_expired` で登録時トライアルの残りを失わないようにする（`entitlement.ts:46`、`sync.ts:39`）。
- **[中] #5** 実 Stripe テストモードでの Checkout → webhook → 反映を 1 回通して記録する。ai-engine の上限超過の降格と `index.ts` の配線もテストに入れる。
