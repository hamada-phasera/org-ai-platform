-- 決済（Stripe のサブスクリプション）の状態を組織に持つ。
--
-- ■ 真実の源: プランは Organization.plan。Stripe の状態は webhook のたびに
--   サブスクリプションを**取り直して**写す。イベントは順不同で届くので、本文の状態をそのまま書かない。
-- ■ 安全性: 既存行を書き換える文は無い（すべて nullable か DEFAULT 付き）。
--   stripeCustomerId は 20260912000000 で足した列で、まだ全行 NULL なので一意制約を張れる。

ALTER TABLE "Organization"
    ADD COLUMN "stripeSubscriptionId" TEXT,
    ADD COLUMN "subscriptionStatus" TEXT,
    ADD COLUMN "billingInterval" TEXT,
    ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
    ADD COLUMN "trialEndsAt" TIMESTAMP(3),
    ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- webhook は顧客ID・サブスクリプションIDから組織を引く。2組織が同じ契約を指したら事故なので一意にする
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");
CREATE UNIQUE INDEX "Organization_stripeSubscriptionId_key" ON "Organization"("stripeSubscriptionId");

-- Stripe webhook の処理済み記録（再送を二度処理しない）
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillingEvent_orgId_createdAt_idx" ON "BillingEvent"("orgId", "createdAt");
