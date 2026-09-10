-- 同じ組織に2人目以降を入れられるようにする（招待 + 権限）。
-- あわせて、決済とストレージが後で使う列も同じ1本に畳んでおく
-- （ALTER TABLE は1文ごとに ACCESS EXCLUSIVE を取るので、テーブル単位でまとめる）。
--
-- ■ 安全性: 既存行を書き換える文が1つも無い。
--   * ADD COLUMN はすべて nullable か非 volatile な DEFAULT 付きなので、
--     PostgreSQL 11+ ではテーブルの書き換えが起きない。
--   * User.role の DEFAULT 変更は pg_attrdef の更新だけ。既存の 'OWNER' は変わらない。
--     効くのは role を省略した今後の INSERT で、現在の /register は role を明示している。
--     省略時に黙って最強権限ができるのを塞ぐための変更（fail-closed）。
--
-- ■ なぜ招待にメールが要らない形にしたか
--   このプロダクトはメールを1通も送れない（nodemailer/resend/SES すべて依存に無い）。
--   メール前提の招待を作ると永久に動かないので、管理者が発行したリンクを
--   手渡す方式にしてある。トークンはハッシュだけを保存し、生値は発行時の1回だけ返す。

-- AlterTable: User（無効化フラグ + role の DEFAULT を fail-closed に）
ALTER TABLE "User"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- AlterTable: Organization（決済の顧客ID + ストレージ使用量カウンタ）
ALTER TABLE "Organization"
    ADD COLUMN "stripeCustomerId" TEXT,
    ADD COLUMN "storageUsedBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable: Invitation
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- 生トークンの照合はハッシュの一意検索で行う
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_orgId_createdAt_idx" ON "Invitation"("orgId", "createdAt");

-- 組織を消したら招待も消す（招待は組織に属する一時的なもの）
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
