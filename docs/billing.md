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
- トライアルは組織ごとに1回。
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
| `STRIPE_PRICE_STORAGE_ADDON` | 追加ストレージ 1GB | **未定** | 月（数量） |

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

## まだ決めていないこと

- **トライアル終了後・解約後にどこまで使わせるか**。いまは梅の上限で使い続けられ、止める仕組みは無い。
- **追加ストレージの単価**。
