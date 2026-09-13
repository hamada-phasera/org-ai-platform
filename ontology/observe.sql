-- 語彙の実態を観測する。読み取りのみ。Neon MCP (run_sql) で実行し、
-- 結果を observed.json として保存する。
SELECT 'Task.department' AS field, department AS value, count(*)::int AS n FROM "Task" GROUP BY department
UNION ALL SELECT 'Agent.department', department, count(*)::int FROM "Agent" GROUP BY department
UNION ALL SELECT 'AILog.department', department, count(*)::int FROM "AILog" GROUP BY department
UNION ALL SELECT 'Task.status', status, count(*)::int FROM "Task" GROUP BY status
UNION ALL SELECT 'Task.taskType', COALESCE("taskType", '(null)'), count(*)::int FROM "Task" GROUP BY "taskType"
UNION ALL SELECT 'User.role', role, count(*)::int FROM "User" GROUP BY role
ORDER BY 1, 3 DESC;
