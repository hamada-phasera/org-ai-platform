# 決済（Stripe）

## 仕組み

| 操作 | どこで | 備考 |
|---|---|---|
| 新規契約 | 設定 > プラン → Stripe Checkout | カード入力は Stripe の画面。このサーバはカード情報を扱わない |
| プラン・支払い間隔の変更 | 設定 > プラン | 契約中のみ。下げた先の容量に今のファイルが収まらなければ止める |
| 支払い方法・請求書・解約 | Stripe のカスタマーポータル | 自前の画面は作らない |
| 追加ストレージ | 設定 > プラン | 課金中（active）の契約だけ。1口 = 1GB / 月 |

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
- 登録時トライアル中に Checkout しても、Stripe 側で無料期間を重ねて付けない（`trialEndsAt` が入っているため即課金）。
  残り期間の引き継ぎ（`subscription_data.trial_end`）は計画書チャンク 3 で足す。
- ⚠️ 止めないもの: `trialEndsAt = null` の既存組織（登録時トライアルより前に作られた組織）と、
  決済が未設定（`STRIPE_SECRET_KEY` なし）の環境の全組織。再開の手段が無い状態で止めないため。
- **解約・未払いのあとは「閲覧のみ」**。新しい実行と保存は 402 で止まり、台帳・ファイル・
  過去のやり取りの閲覧と書き出しは続けられる。データは消さない。
  削除するなら90日後に予告してから、という方針だが**自動削除はまだ実装していない**（運用で行う）。
- **月間の AI 呼び出しは、超えても止めない**。8割で画面に警告を出し、超えたら軽いモデルに
  落として使い続けさせる。上限と挙動は `tests/fixtures/plan-models.json` が正本。
- 解約予約は `cancel_at_period_end`（従来の請求モード）と `cancel_at`（柔軟な請求モード）の両方を読む。
- 金額はコードに持たない。画面に出す金額も Stripe の価格から取る（10分キャッシュ）。

## Stripe ダッシュボードで用意するもの

テスト環境で一通り作って動作を確認してから、本番環境で同じものを作る。

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

`.env.example` の「決済 (Stripe)」を参照。`STRIPE_SECRET_KEY` が無ければ決済は未設定として扱い、
設定 > プラン は「準備中」を表示するだけで、他の機能には影響しない。

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
