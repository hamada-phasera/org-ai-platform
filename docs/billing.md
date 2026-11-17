# 決済（Stripe）

## 仕組み

| 操作 | どこで | 備考 |
|---|---|---|
| 新規契約 | 設定 > プラン → Stripe Checkout | カード入力は Stripe の画面。このサーバはカード情報を扱わない |
| プラン・支払い間隔の変更 | 設定 > プラン | 契約中のみ。下げた先の容量に今のファイルが収まらなければ止める |
| 支払い方法・請求書・解約 | Stripe のカスタマーポータル | 自前の画面は作らない |
| 追加ストレージ | 設定 > プラン | 課金中（active）の契約だけ。1口 = 10GB / 月 |

- **組織への写し込みは webhook が正本**（`/api/webhooks/stripe`）。イベントは順不同で届くので、
  毎回サブスクリプションを取り直して `Organization` に写す。処理済みの印（`BillingEvent`）は成功してから書く。
- 権利があるのは `trialing` / `active` / `past_due`（past_due は Stripe が再請求している猶予期間）。
  それ以外になったら梅の上限と追加容量 0 に戻す。**データは消さない**。
- **登録と同時にカード不要のトライアルが始まる**（`trialEndsAt = 作成時刻 + BILLING_TRIAL_DAYS`、既定 30 日）。
  上限は梅。期限を過ぎて未契約（`subscriptionStatus = null`）なら、決済が設定済みの環境では「閲覧のみ」。
  402 のコードは解約と同じ `SUBSCRIPTION_REQUIRED`、文言だけ「無料期間が終了」に変わる。
  判定は `services/entitlement.ts` の `entitlementOf`（純粋関数、要求時刻で判定）。
- トライアルは**作成者ごとに1回**。すでに自分で組織を作った人の 2 つ目以降は、作成時点で期限切れ
  （契約するまで閲覧のみ）。招待で入った組織は数えない。
- 登録時トライアル中に Checkout すると、**残り期間をそのまま引き継ぐ**（`subscription_data.trial_end = trialEndsAt`）。
  早く契約した人が損をしないためで、無料期間の終わりの日は延びない。Stripe は `trial_end` が 48 時間以上先でないと
  拒否するので、残りが 49 時間（1 時間の余裕）未満ならその日から課金する。判定は `billing-core.ts` の `checkoutTrialEnd`。
  画面の文言は overview の `checkoutTrialEndsAt` に従う。⚠️ 一度でも契約した組織（解約後の再契約など）には引き継がない。
- ⚠️ 止めないもの: `trialEndsAt = null` の既存組織（登録時トライアルより前に作られた組織）と、
  決済が未設定の環境の全組織。再開の手段が無い状態で止めないため。「決済設定済み」は `STRIPE_SECRET_KEY`・
  `STRIPE_PRICE_STARTER_MONTHLY`・`STRIPE_WEBHOOK_SECRET` の **3 つ**がそろったとき（`config.billingConfigured`）。
  キーだけだと契約できないのに止まり、署名鍵が無いと支払っても組織に写らない（写し込みは webhook だけ）。
  署名鍵が無ければ `/api/billing/checkout` も 503 `BILLING_NOT_CONFIGURED`（固定文言）で申し込ませない。
- **解約・未払いのあとは「閲覧のみ」**。新しい実行と保存は 402 で止まり、台帳・ファイル・
  過去のやり取りの閲覧と書き出しは続けられる。データは消さない。
- **認証の無い経路も止める**。定期実行（gateway 内 tick と n8n の `enqueue-scheduled-task`）は claim の前に組織を見て
  skip し（`lastRunAt` を進めない＝契約し直せばその時間帯のうちに走る）、n8n の `scheduled-jobs` 一覧からも外す。
  LINE 受信は**メッセージの保存だけ続け**、下書き生成と領収書の読み取り（AI）はしない（受信箱には「ご契約が無いため…」と出る。
  画像は保存しないので、契約後に撮り直してもらう）。判定は `services/org-entitlement.ts` → `entitlementDecision` の 1 か所。
  削除するなら90日後に予告してから、という方針だが**自動削除はまだ実装していない**（運用で行う）。
- **月間の AI 呼び出しは、超えても止めない**。8割で画面に警告を出し、超えたら軽いモデルに
  落として使い続けさせる。上限と挙動は `tests/fixtures/plan-models.json` が正本。
- 解約予約は `cancel_at_period_end`（従来の請求モード）と `cancel_at`（柔軟な請求モード）の両方を読む。
- 金額はコードに持たない。画面に出す金額も Stripe の価格から取る（10分キャッシュ）。

## Stripe 側の用意（テストモードは 1 コマンド）

```bash
# 確認のみ（既定。何も作らない）
STRIPE_SECRET_KEY=sk_test_... npm run stripe:bootstrap
# 足りないものを作る。webhook の宛先も作るなら URL を渡す
STRIPE_SECRET_KEY=sk_test_... npm run stripe:bootstrap -- --apply \
  --webhook-url=https://<api-gateway のURL>/api/webhooks/stripe
```

- `scripts/stripe-bootstrap.mjs`（依存ゼロ）。下の 1・2・4・5 を作り、最後に貼り付け用の環境変数を出す
  （`STRIPE_PRICE_*`・`STRIPE_TAX_RATE_ID`・作ったときだけ `STRIPE_WEBHOOK_SECRET`）。`STRIPE_SECRET_KEY` は出さない。
- 何度流しても増えない（価格は `lookup_key = flow_<plan>_<monthly|yearly>` / `flow_storage_addon_10gb`、
  商品・税率は metadata で既存を探す）。価格の金額が表と違っていても作り直さず警告だけ（Stripe の価格は変えられない）。
- ⚠️ 本番キー（`sk_live_` / `rk_live_`）は Stripe を 1 回も呼ばずに拒否する。本番は下の手順を手で行う。
- webhook の署名鍵は Stripe が作成時にしか返さない。出たらすぐ控える（2 回目以降はダッシュボードで確認）。
- 請求書の登録番号（3）だけは手作業。
- 課金の流れ全体は `apps/api-gateway/tests/billing/billing-flow.test.ts` が偽 Stripe で通しで確かめている
  （登録 → Checkout → 竹 → 未払いの猶予 → 解約で閲覧のみ → 再契約で復帰）。

## Stripe ダッシュボードで用意するもの

テスト環境で一通り作って動作を確認してから、本番環境で同じものを作る（テストは上のスクリプトで足りる）。

### 1. 商品と価格（すべて JPY・税抜・継続課金）

| 環境変数 | 商品 | 金額（税抜） | 間隔 |
|---|---|---|---|
| `STRIPE_PRICE_STARTER_MONTHLY` | FLOW 梅 | 9,800円 | 月 |
| `STRIPE_PRICE_STARTER_YEARLY` | FLOW 梅 | 94,080円 | 年 |
| `STRIPE_PRICE_PRO_MONTHLY` | FLOW 竹 | 19,800円 | 月 |
| `STRIPE_PRICE_PRO_YEARLY` | FLOW 竹 | 190,080円 | 年 |
| `STRIPE_PRICE_MAX_MONTHLY` | FLOW 松 | 34,800円 | 月 |
| `STRIPE_PRICE_MAX_YEARLY` | FLOW 松 | 334,080円 | 年 |
| `STRIPE_PRICE_STORAGE_ADDON` | 追加ストレージ 10GB | 1,000円 | 月（数量） |

年額は月額 × 12 × 0.8（20%引）。価格は `docs/pricing/README.md` の決定に合わせる。

### 2. 税率

消費税 10%・**外税**（inclusive = false）の tax rate を作り、`STRIPE_TAX_RATE_ID` に入れる。
価格を税抜で作っているので、未設定だと税が上乗せされない。

### 3. 請求書の設定

適格請求書発行事業者の登録番号（T + 13桁）を請求書に表示する（設定 > 請求書 のカスタムフィールドかフッター）。
顧客の建設会社が仕入税額控除を受けるのに必要になる。

### 4. カスタマーポータル

- **プランの変更は無効にする**（アプリ内で行う）。Stripe の制限事項に「複数の商品を使うサブスクリプションは、
  ポータルでキャンセルはできるが更新はできない」とあり、追加ストレージを買った契約ではプランを変えられない。
  また、ポータルでは下げた先の容量に今のファイルが収まるかを確かめられない
- 解約は「期間の終わりに解約」
- 請求書の履歴と支払い方法の更新を有効にする

### 5. Webhook

- エンドポイント: `https://<api-gateway のURL>/api/webhooks/stripe`
- イベント: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`
- 署名シークレットを `STRIPE_WEBHOOK_SECRET` に入れる

## 環境変数（api-gateway）

`.env.example` の「決済 (Stripe)」を参照。`STRIPE_SECRET_KEY` か `STRIPE_PRICE_STARTER_MONTHLY` が無ければ決済は未設定として扱い、
設定 > プラン は「準備中」を表示するだけで、他の機能には影響しない（トライアル切れでも止めない）。
`STRIPE_WEBHOOK_SECRET` だけが無いときは、価格は表示されるが申し込みは 503 で、期限切れの組織も止めない。
Render への入れ方は `docs/DEPLOY.md` の 3・4 章。

## 公開の前に（法務の頁）

Stripe の本番の審査と有償の販売には、利用規約・プライバシーポリシー・特定商取引法に基づく表記が要る。

- 頁は `/legal/terms` `/legal/privacy` `/legal/tokushoho`（認証の外。登録・ログイン・設定 > プラン の下からリンク）。
- 見出しと項目だけを置いてあり、内容は `apps/web/src/pages/legal/content.ts` の `value: null`＝画面に「未記入」と出る。
  文面・事業者名・所在地・連絡先・登録番号はオーナーが入れる（計画書 O-7）。このリポジトリでは文面を作らない。
- 特商法の「販売価格」は Stripe の価格と同じ金額を書くか「設定 > プラン に表示」とする（金額はコードに持たない）。
- Stripe ダッシュボードの公開情報（ビジネスのウェブサイト・利用規約・プライバシーポリシーの URL を入れる欄）に上の URL を入れる。

### 既存の組織をトライアルに乗せる（任意・手作業）

既定では乗せない（`trialEndsAt = null` のまま止まらない）。乗せると決めたら、件数を確かめてから流す。

```sql
-- 対象の件数（未契約・トライアル未設定）
SELECT count(*) FROM "Organization" WHERE "subscriptionStatus" IS NULL AND "trialEndsAt" IS NULL;
-- 今から 30 日のトライアルを付ける（決済設定済みなら、期限後は閲覧のみ）
UPDATE "Organization" SET "trialEndsAt" = now() + interval '30 days'
 WHERE "subscriptionStatus" IS NULL AND "trialEndsAt" IS NULL;
```

所属のキャッシュは 30 秒で切れるので、gateway の再起動は要らない。

## 解約したお客さまのデータ

| 期間 | 扱い |
|---|---|
| 解約直後〜 | 閲覧のみ（新規の実行・保存は不可）。請求は発生しない |
| 90日後 | 削除の予告を出す（運用。自動化していない） |
| 予告後 | 削除 |

## まだ決めていないこと

- 追加ストレージの単価は 10GB 月1,000円に決めた（kintone のディスク増設と同額）。
  原価は Supabase で 10GB あたり月 30 円程度（100GB までは Pro プランに込み）。
