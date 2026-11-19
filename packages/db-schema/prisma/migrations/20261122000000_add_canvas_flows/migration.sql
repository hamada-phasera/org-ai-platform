-- ホームキャンバスと業務フロー。設計: docs/design/canvas-home.md §5（チャンク 3）
--
-- ■ 中身
--   Canvas（ホームの配置。組織に 1 行）/ Flow（フローの現在の定義）/ FlowVersion（定義の履歴。Flow の子）/
--   FlowRun（実行 1 回＝監査・月間実行数の正本・簡易キュー）の 4 表を新規に作り、
--   CustomPage.flowId（フローの結果ページ）と ScheduledTask.flowId（定期のきっかけ）の列を足す。
--   追加のみ（既存の行は flowId = NULL のまま。アプリを前の版に戻してもこの表と列を読まないだけで動く）。
--
-- ■ 一意制約（設計の要）
--   Canvas      (orgId)            … 組織に 1 枚（U-8・K18）
--   Flow        (orgId, slug)      … 同じテンプレートを 2 人が同時に押してもフローは 1 つ（slug = templateKey）
--   FlowRun     (orgId, requestId) … 同じ実行の二重受け付けを DB で止める
--   FlowVersion (flowId, version)  … 同じ版を 2 回書かない
--   FlowRun     (taskId)           … 実行 1 回 = Task 1 行
--   CustomPage  (flowId)           … フロー 1 つに結果ページ 1 つ（NULL は複数可＝既存のページに影響なし）
--
-- ■ 消え方
--   組織を消すと Canvas / Flow / FlowRun が消え、Flow に付いて FlowVersion・結果ページ・定期の行も消える（CASCADE）。
--   FlowRun.flowId は FK にしない: フローを消しても当月の件数を残す（消して作り直して上限をすり抜けさせない。K25）。
--   ScheduledTask.flowId は SET NULL にしない: flowId も agentId も無い行は「部署ワークフローの定期実行」に化けるため。
--
-- ■ RLS: Phase 2a には足さない（設計書 K24。tenantDb で強制、raw SQL なし）。Phase 2b の草案に追記済み。
--
-- ■ ロールバック（Prisma migrate に down は無いので手で流す）
--   ALTER TABLE "ScheduledTask" DROP CONSTRAINT "ScheduledTask_flowId_fkey"; DROP INDEX "ScheduledTask_flowId_idx";
--   ALTER TABLE "ScheduledTask" DROP COLUMN "flowId";
--   ALTER TABLE "CustomPage" DROP CONSTRAINT "CustomPage_flowId_fkey"; DROP INDEX "CustomPage_flowId_key";
--   ALTER TABLE "CustomPage" DROP COLUMN "flowId";
--   DROP TABLE "FlowRun"; DROP TABLE "FlowVersion"; DROP TABLE "Flow"; DROP TABLE "Canvas";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122000000_add_canvas_flows';

-- AlterTable
ALTER TABLE "CustomPage" ADD COLUMN     "flowId" TEXT;

-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "flowId" TEXT;

-- CreateTable
CREATE TABLE "Canvas" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "layout" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Canvas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'file-text',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minRole" TEXT NOT NULL DEFAULT 'MEMBER',
    "templateKey" TEXT,
    "templateVersion" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowVersion" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "flowSlug" TEXT NOT NULL,
    "flowVersion" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "trigger" TEXT NOT NULL,
    "actorId" TEXT,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" JSONB,
    "partCalls" INTEGER NOT NULL DEFAULT 0,
    "aiCalls" INTEGER NOT NULL DEFAULT 0,
    "taskId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Canvas_orgId_key" ON "Canvas"("orgId");

-- CreateIndex
CREATE INDEX "Flow_orgId_updatedAt_idx" ON "Flow"("orgId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_orgId_slug_key" ON "Flow"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "FlowVersion_flowId_version_key" ON "FlowVersion"("flowId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FlowRun_taskId_key" ON "FlowRun"("taskId");

-- CreateIndex
CREATE INDEX "FlowRun_orgId_createdAt_idx" ON "FlowRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "FlowRun_orgId_flowId_createdAt_idx" ON "FlowRun"("orgId", "flowId", "createdAt");

-- CreateIndex
CREATE INDEX "FlowRun_status_createdAt_idx" ON "FlowRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlowRun_orgId_requestId_key" ON "FlowRun"("orgId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomPage_flowId_key" ON "CustomPage"("flowId");

-- CreateIndex
CREATE INDEX "ScheduledTask_flowId_idx" ON "ScheduledTask"("flowId");

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomPage" ADD CONSTRAINT "CustomPage_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Canvas" ADD CONSTRAINT "Canvas_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowVersion" ADD CONSTRAINT "FlowVersion_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

