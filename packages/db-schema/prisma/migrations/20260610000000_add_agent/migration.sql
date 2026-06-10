-- CreateEnum
CREATE TYPE "AgentN8nStatus" AS ENUM ('PENDING', 'CREATED', 'ACTIVE', 'FAILED', 'FALLBACK_ONLY');

-- CreateEnum
CREATE TYPE "AgentTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "agentId" TEXT;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "department" TEXT NOT NULL DEFAULT 'GENERAL',
    "instructions" TEXT NOT NULL,
    "steps" JSONB,
    "trigger" "AgentTrigger" NOT NULL DEFAULT 'MANUAL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "n8nWorkflowId" TEXT,
    "webhookPath" TEXT,
    "n8nStatus" "AgentN8nStatus" NOT NULL DEFAULT 'PENDING',
    "icon" TEXT,
    "color" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_orgId_agentId_idx" ON "Task"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "Agent_orgId_enabled_idx" ON "Agent"("orgId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_orgId_name_key" ON "Agent"("orgId", "name");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
