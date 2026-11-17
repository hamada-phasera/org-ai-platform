-- 業務ページ（n8n 連携）。設計: docs/design/custom-pages.md §3（チャンク 2）
--
-- ■ 中身
--   CustomPage（ページ定義）/ PageToken（ページ登録トークン。ハッシュだけ）/ PageActionLog（送信の記録＝月間実行数の正本）。
--   3 表とも新規。既存の表・行には触らない（追加のみ）。アプリを前の版に戻してもこの表を読まないだけで動く。
--
-- ■ 一意制約（設計の要）
--   CustomPage    (orgId, slug)      … 同じ slug の同時 upsert でも 1 行
--   PageActionLog (orgId, requestId) … 同じ送信の二重実行を DB で止める（先に行を作ってから n8n を呼ぶ）
--   PageToken     (tokenHash)        … ハッシュから組織を一意に引く
--
-- ■ 消え方
--   組織を消すと 3 表とも消える（ON DELETE CASCADE）。
--   PageActionLog.pageId は FK にしない: ページを消しても当月の件数を残す（消して作り直して上限をすり抜けさせない）。
--
-- ■ RLS: Phase 2a には足さない（設計書 K16。tenantDb で強制、raw SQL なし）。Phase 2b の草案に追記済み。
--
-- ■ ロールバック（Prisma migrate に down は無いので手で流す）
--   DROP TABLE "PageActionLog"; DROP TABLE "PageToken"; DROP TABLE "CustomPage";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261121000000_add_custom_pages';

-- CreateTable
CREATE TABLE "CustomPage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'file-text',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "minRole" TEXT NOT NULL DEFAULT 'MEMBER',
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "sampleData" JSONB,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageToken" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageActionLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "pageVersion" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "durationMs" INTEGER,
    "inputKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomPage_orgId_status_sortOrder_idx" ON "CustomPage"("orgId", "status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CustomPage_orgId_slug_key" ON "CustomPage"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "PageToken_tokenHash_key" ON "PageToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PageToken_orgId_createdAt_idx" ON "PageToken"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PageActionLog_orgId_createdAt_idx" ON "PageActionLog"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PageActionLog_orgId_requestId_key" ON "PageActionLog"("orgId", "requestId");

-- AddForeignKey
ALTER TABLE "CustomPage" ADD CONSTRAINT "CustomPage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageToken" ADD CONSTRAINT "PageToken_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageActionLog" ADD CONSTRAINT "PageActionLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
