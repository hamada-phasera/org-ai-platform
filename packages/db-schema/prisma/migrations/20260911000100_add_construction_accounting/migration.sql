-- 建設業向け経理: 工事（現場）単位の原価管理。
--
-- 新規テーブル3つのみで既存行に一切触れないため、本番の prisma migrate deploy で安全。
--
-- 設計の要点:
--   * 一般の経費精算と違い、建設業の経理はすべて「工事」単位で回る。
--   * 原価は材料費・労務費・外注費・経費の4分類で持つ。これは建設業会計の標準であり、
--     2025年12月全面施行の改正建設業法で見積書への内訳記載が努力義務になった区分でもある。
--   * 金額はすべて円単位の INTEGER（小数を持ち込まない）。
--   * 本体価格(amount)と消費税額(taxAmount)を分けて持つ。請負金額が税抜なので、
--     原価を税込で持つと粗利が消費税分だけ過小に出る。また労務費（自社雇用）は
--     不課税なので、一律10%と仮定するとインボイスの負担試算がずれる。
--   * Vendor.invoiceRegistered は、2026年10月に控除の経過措置が 80%→70% へ下がるため、
--     未登録先との取引額と追加負担の試算に使う。

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT,
    "contractAmount" INTEGER NOT NULL DEFAULT 0,
    "startOn" TIMESTAMP(3),
    "dueOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ESTIMATING',
    "budgetMaterial" INTEGER NOT NULL DEFAULT 0,
    "budgetLabor" INTEGER NOT NULL DEFAULT 0,
    "budgetSubcon" INTEGER NOT NULL DEFAULT 0,
    "budgetOther" INTEGER NOT NULL DEFAULT 0,
    "progressRate" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SUBCON',
    "invoiceRegistered" BOOLEAN NOT NULL DEFAULT false,
    "invoiceNumber" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "vendorId" TEXT,
    "incurredOn" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_orgId_code_key" ON "Project"("orgId", "code");
CREATE INDEX "Project_orgId_status_idx" ON "Project"("orgId", "status");
CREATE UNIQUE INDEX "Vendor_orgId_name_key" ON "Vendor"("orgId", "name");
CREATE INDEX "Vendor_orgId_invoiceRegistered_idx" ON "Vendor"("orgId", "invoiceRegistered");
CREATE INDEX "CostEntry_orgId_projectId_incurredOn_idx" ON "CostEntry"("orgId", "projectId", "incurredOn");
CREATE INDEX "CostEntry_orgId_status_idx" ON "CostEntry"("orgId", "status");

ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- 工事を消したら明細も消す。取引先を消しても明細は残す（金額の履歴を失わない）
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
