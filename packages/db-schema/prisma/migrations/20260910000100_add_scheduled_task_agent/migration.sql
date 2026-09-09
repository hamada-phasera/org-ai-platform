-- 定期実行トリガー: ScheduledTask からエージェントを起動できるようにする。
-- カラム追加 + FK + インデックスのみ。既存行には触れないため本番の prisma migrate deploy で安全。
-- ON DELETE SET NULL: エージェント削除後も定期タスク行は残る（routes/agents.ts の DELETE が
-- 紐づく定期タスクを明示的に削除して孤児を防ぐ。万一残っても enqueue 側が skip する）。

ALTER TABLE "ScheduledTask" ADD COLUMN "agentId" TEXT;

ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ScheduledTask_agentId_idx" ON "ScheduledTask"("agentId");
