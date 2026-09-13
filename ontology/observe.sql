-- 語彙の実態を観測する。読み取りのみ。Supabase MCP (execute_sql) で実行し、
-- 結果を observed.json として保存する。
-- ⚠️ 本番は Supabase。Neon は 2026-07 で止まった旧 DB で、参照しないこと。
--
-- 同じ語彙を使う列は全部ここに並べる。列を落とすと「違反 0 件」が
-- 「検査していないだけ」を意味してしまう（2026-09-13 に department 系を3列落としていた）。
SELECT 'Task.department' AS field, department AS value, count(*)::int AS n FROM "Task" GROUP BY 2
UNION ALL SELECT 'Agent.department', department, count(*)::int FROM "Agent" GROUP BY 2
UNION ALL SELECT 'AILog.department', department, count(*)::int FROM "AILog" GROUP BY 2
UNION ALL SELECT 'Capability.department', COALESCE(department,'(null)'), count(*)::int FROM "Capability" GROUP BY 2
UNION ALL SELECT 'ScheduledTask.department', department, count(*)::int FROM "ScheduledTask" GROUP BY 2
UNION ALL SELECT 'Message.department', COALESCE(department,'(null)'), count(*)::int FROM "Message" GROUP BY 2
UNION ALL SELECT 'Task.status', status, count(*)::int FROM "Task" GROUP BY 2
UNION ALL SELECT 'Task.taskType', COALESCE("taskType",'(null)'), count(*)::int FROM "Task" GROUP BY 2
UNION ALL SELECT 'ScheduledTask.taskType', COALESCE("taskType",'(null)'), count(*)::int FROM "ScheduledTask" GROUP BY 2
UNION ALL SELECT 'User.role', role, count(*)::int FROM "User" GROUP BY 2
UNION ALL SELECT 'Invitation.role', role, count(*)::int FROM "Invitation" GROUP BY 2
UNION ALL SELECT 'User.status', status, count(*)::int FROM "User" GROUP BY 2
-- 決済・保存先（2026-09-11 追加）
UNION ALL SELECT 'Organization.plan', plan, count(*)::int FROM "Organization" GROUP BY 2
UNION ALL SELECT 'Organization.subscriptionStatus', COALESCE("subscriptionStatus",'(null)'), count(*)::int FROM "Organization" GROUP BY 2
UNION ALL SELECT 'Organization.billingInterval', COALESCE("billingInterval",'(null)'), count(*)::int FROM "Organization" GROUP BY 2
UNION ALL SELECT 'UploadedFile.storageDriver', "storageDriver", count(*)::int FROM "UploadedFile" GROUP BY 2
-- 建設業の経理（2026-09-11 追加・まだ 0 件）
UNION ALL SELECT 'Project.status', status, count(*)::int FROM "Project" GROUP BY 2
UNION ALL SELECT 'CostEntry.category', category, count(*)::int FROM "CostEntry" GROUP BY 2
UNION ALL SELECT 'CostEntry.status', status, count(*)::int FROM "CostEntry" GROUP BY 2
UNION ALL SELECT 'CostEntry.source', source, count(*)::int FROM "CostEntry" GROUP BY 2
UNION ALL SELECT 'Vendor.kind', kind, count(*)::int FROM "Vendor" GROUP BY 2
-- 連携・実行・監査
UNION ALL SELECT 'Capability.kind', kind, count(*)::int FROM "Capability" GROUP BY 2
UNION ALL SELECT 'ChannelConnection.status', status, count(*)::int FROM "ChannelConnection" GROUP BY 2
UNION ALL SELECT 'ProviderConnection.status', status, count(*)::int FROM "ProviderConnection" GROUP BY 2
UNION ALL SELECT 'InboundMessage.status', status, count(*)::int FROM "InboundMessage" GROUP BY 2
UNION ALL SELECT 'ExecutionLog.status', status, count(*)::int FROM "ExecutionLog" GROUP BY 2
UNION ALL SELECT 'RiskEvent.severity', severity, count(*)::int FROM "RiskEvent" GROUP BY 2
UNION ALL SELECT 'AILog.provider', COALESCE(provider,'(null)'), count(*)::int FROM "AILog" GROUP BY 2
UNION ALL SELECT 'Message.role', role, count(*)::int FROM "Message" GROUP BY 2
ORDER BY 1, 3 DESC;
