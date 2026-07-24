-- SNS 下書き等の予約投稿日時。従来は Task.output JSON 内に格納していたが、索引・カレンダー集計のためカラム化。
-- 追加のみ・NULL 許容なので既存行に影響なし（本番 prisma migrate deploy で安全に適用可能）。
-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Task_orgId_scheduledAt_idx" ON "Task"("orgId", "scheduledAt");

-- 営業パイプラインの商談。従来は routes/sales/pipeline.ts のインメモリ Map。永続化のためテーブル化。
-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'LEAD',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deal_orgId_stage_idx" ON "Deal"("orgId", "stage");

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
