-- usage-metrics-svc — schema for the read path and the daily rollup.
--
-- The service READS org-ai-platform's existing "AILog" table (created by the
-- main app's Prisma migrations — NOT here) and OWNS usage_daily_rollup below.
-- Apply this on a Neon dev branch for benchmarking, or in prod once reviewed.

-- ── PHASE 3 stage 2 ─────────────────────────────────────────────────────────
-- Index that turns the per-tenant window query from a Seq Scan into an index
-- scan.  Measured on 200k rows / 20 tenants (Neon pg17): ~41ms → ~5.3ms.
CREATE INDEX IF NOT EXISTS idx_ailog_org_created ON "AILog" ("orgId", "createdAt");

-- ── PHASE 3 stage 3 / PHASE 4 ───────────────────────────────────────────────
-- Pre-aggregated daily rollup.  Keyed by (org_id, day, provider, model,
-- department) so cost stays model-aware (priced in the Go service) and the
-- department breakdown is reproducible.  The PHASE 4 worker maintains it; the
-- API can serve from it.  A 30-day read is an index scan over a few rows.
CREATE TABLE IF NOT EXISTS usage_daily_rollup (
  org_id         text     NOT NULL,
  day            date     NOT NULL,   -- UTC calendar day of "createdAt"
  provider       text     NOT NULL,
  model          text     NOT NULL,
  department     text     NOT NULL,
  calls          integer  NOT NULL,
  sum_tokens     bigint   NOT NULL,
  sum_latency_ms bigint   NOT NULL,
  count_latency  integer  NOT NULL,   -- # rows with non-null latency (avg denom.)
  p95_latency_ms integer  NOT NULL,   -- exact p95 for THIS grain row only
  PRIMARY KEY (org_id, day, provider, model, department)
);

-- Idempotent backfill / refresh.  The PHASE 4 worker runs this same upsert
-- incrementally, bounded to recent days (WHERE "createdAt" >= now() - N days).
-- Re-running is safe — ON CONFLICT makes it converge, never duplicate.
--
-- NOTE on p95: it is exact PER rollup-grain row.  Recomposing a (day,provider)
-- or window-wide p95 from these is only approximate (percentiles don't
-- compose); the rollup read takes max() as a conservative upper bound, and the
-- raw read computes exact p95.  A proper fix (t-digest / histogram per grain) is
-- discussed in DESIGN.md.
INSERT INTO usage_daily_rollup (org_id, day, provider, model, department, calls, sum_tokens, sum_latency_ms, count_latency, p95_latency_ms)
SELECT
  "orgId", ("createdAt")::date, provider, model, department,
  count(*),
  COALESCE(sum(tokens), 0),
  COALESCE(sum("latencyMs"), 0),
  count("latencyMs"),
  COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY "latencyMs"), 0)::int
FROM "AILog"
GROUP BY "orgId", ("createdAt")::date, provider, model, department
ON CONFLICT (org_id, day, provider, model, department) DO UPDATE SET
  calls          = EXCLUDED.calls,
  sum_tokens     = EXCLUDED.sum_tokens,
  sum_latency_ms = EXCLUDED.sum_latency_ms,
  count_latency  = EXCLUDED.count_latency,
  p95_latency_ms = EXCLUDED.p95_latency_ms;

-- ── Read-only posture (defense in depth) ────────────────────────────────────
-- The raw read path runs every query inside a READ ONLY transaction.  The
-- rollup worker is the only writer, and it writes ONLY usage_daily_rollup.  In
-- prod, connect with a least-privilege role that encodes exactly that:
--
--   CREATE ROLE metrics_svc LOGIN PASSWORD '***';
--   GRANT USAGE ON SCHEMA public TO metrics_svc;
--   GRANT SELECT ON "AILog" TO metrics_svc;                             -- read only
--   GRANT SELECT, INSERT, UPDATE ON usage_daily_rollup TO metrics_svc;  -- owns rollup
