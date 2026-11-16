-- 1人のユーザーが複数の組織に入れるようにする（Membership）。
-- 設計: docs/design/multi-tenancy.md §9.1 / ADR-2
--
-- ■ 安全性
--   * 既存の User 行は書き換えない（User.orgId / User.role はそのまま残し、意味だけ変える）。
--     User.orgId = 「最後に選んだ組織」、User.role = 移行期間中の写し（判定には使わない）。
--   * Membership のバックフィルは INSERT ... SELECT の1文。User の件数は数百規模の想定なので
--     1トランザクションで終わる。
--   * ON CONFLICT DO NOTHING なので、何度流しても結果が同じ（再実行しても安全）。
--   * Organization への ADD COLUMN は nullable のみ（テーブルの書き換えは起きない）。
--   * この migration を当てただけではアプリの挙動は変わらない（古いアプリは Membership を読まない）。
--
-- ■ User.orgId が null のユーザー
--   Membership を作らない。ログインすると「所属組織なし」になり、招待を受けるか組織を作る
--   （オーナー確認待ち Q4 の仮採用）。事前に件数を確認する:
--     SELECT count(*) FROM "User" WHERE "orgId" IS NULL;
--
-- ■ ロールバック（Prisma migrate に down は無いので手で流す）
--   アプリを前のバージョンに戻すだけなら、この migration はそのままでよい
--   （User.orgId / User.role は二重書き込みで最新に保たれている）。
--   migration ごと戻す場合（2つ目以降の所属は失われるので、先に退避する）:
--     \copy (SELECT * FROM "Membership") TO 'membership_backup.csv' CSV HEADER
--     DROP TABLE "Membership";
--     ALTER TABLE "Organization" DROP COLUMN "createdBy";
--     DELETE FROM "_prisma_migrations" WHERE migration_name = '20261120000000_add_membership';

-- CreateTable: Membership
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invitedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");

-- CreateIndex
CREATE INDEX "Membership_orgId_status_idx" ON "Membership"("orgId", "status");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: 組織の作成者（トライアルの使用済み判定と監査に使う。既存の行は null）
ALTER TABLE "Organization" ADD COLUMN "createdBy" TEXT;

-- バックフィル: 今の「1人1組織」を、そのまま1件の Membership にする。
--   * role は User.role を写す（不正な値は MEMBER に落とす = fail-closed）
--   * status は User.status を写す（無効化済みの人は、その組織で無効のまま）
--   * id は cuid を SQL で作れないので 'mig_' || User.id（一意。アプリは id の形式に依存しない）
--   * updatedAt は Prisma の @updatedAt なので DEFAULT を持たない。ここで明示する
INSERT INTO "Membership" ("id", "userId", "orgId", "role", "status", "createdAt", "updatedAt")
SELECT 'mig_' || u."id",
       u."id",
       u."orgId",
       CASE WHEN u."role" IN ('OWNER', 'ADMIN', 'MEMBER') THEN u."role" ELSE 'MEMBER' END,
       CASE WHEN u."status" IN ('ACTIVE', 'DISABLED') THEN u."status" ELSE 'ACTIVE' END,
       u."createdAt",
       CURRENT_TIMESTAMP
FROM "User" u
WHERE u."orgId" IS NOT NULL
ON CONFLICT ("userId", "orgId") DO NOTHING;
