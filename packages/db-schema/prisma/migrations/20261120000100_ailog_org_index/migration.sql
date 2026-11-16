-- AILog / RiskEvent の (orgId, createdAt) 索引を正規の migration に取り込む（設計書 E9 / §9.2）。
--
-- ■ 背景
--   ai-engine の月間上限判定（governance/usage.py）と /api/organizations/me/usage の count は
--   この索引を前提にしているが、AILog の索引は usage-metrics-svc/schema.sql が Prisma の外で
--   作っていただけだった。名前を同じ "idx_ailog_org_created" にしてあるので、既にある本番では
--   IF NOT EXISTS で何も起きない（schema.prisma 側も map で同じ名前を指す＝drift しない）。
--
-- ■ ⚠️ ロック
--   CREATE INDEX（CONCURRENTLY なし）は対象テーブルへの書き込みを止める。AILog が大きい場合は、
--   本番で先に手動で次を流しておき、この migration は IF NOT EXISTS で素通りさせる:
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ailog_org_created" ON "AILog" ("orgId", "createdAt");
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS "RiskEvent_orgId_createdAt_idx" ON "RiskEvent" ("orgId", "createdAt");
--   （CONCURRENTLY はトランザクションの中で流せないので migration には書けない）
--
-- ■ ロールバック: 索引は残してよい（害が無い）。消す場合は DROP INDEX IF EXISTS を2本。

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_ailog_org_created" ON "AILog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RiskEvent_orgId_createdAt_idx" ON "RiskEvent"("orgId", "createdAt");
