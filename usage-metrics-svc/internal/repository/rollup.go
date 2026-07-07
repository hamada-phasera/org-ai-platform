package repository

import (
	"context"
	"fmt"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RollupRepository reads and maintains usage_daily_rollup. It is the ONLY writer
// in the service, and it writes ONLY this table — it reads AILog (to aggregate)
// but never mutates it.
type RollupRepository struct {
	pool *pgxpool.Pool
}

// NewRollupRepository wraps a pgx pool.
func NewRollupRepository(pool *pgxpool.Pool) *RollupRepository {
	return &RollupRepository{pool: pool}
}

// refreshSQL re-aggregates AILog into usage_daily_rollup for the last $1 days.
// Idempotent: ON CONFLICT upsert means re-running converges, never duplicates.
const refreshSQL = `
INSERT INTO usage_daily_rollup (org_id, day, provider, model, department, calls, sum_tokens, sum_latency_ms, count_latency, p95_latency_ms)
SELECT
  "orgId", ("createdAt")::date, provider, model, department,
  count(*),
  COALESCE(sum(tokens), 0),
  COALESCE(sum("latencyMs"), 0),
  count("latencyMs"),
  COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY "latencyMs"), 0)::int
FROM "AILog"
WHERE "createdAt" >= NOW() - make_interval(days => $1)
GROUP BY "orgId", ("createdAt")::date, provider, model, department
ON CONFLICT (org_id, day, provider, model, department) DO UPDATE SET
  calls          = EXCLUDED.calls,
  sum_tokens     = EXCLUDED.sum_tokens,
  sum_latency_ms = EXCLUDED.sum_latency_ms,
  count_latency  = EXCLUDED.count_latency,
  p95_latency_ms = EXCLUDED.p95_latency_ms`

// RefreshRollup re-aggregates the last sinceDays of AILog into the rollup and
// returns the number of grain rows upserted. This is the worker's unit of work.
func (r *RollupRepository) RefreshRollup(ctx context.Context, sinceDays int) (int64, error) {
	tag, err := r.pool.Exec(ctx, refreshSQL, sinceDays)
	if err != nil {
		return 0, fmt.Errorf("refresh rollup: %w", err)
	}
	return tag.RowsAffected(), nil
}

const fetchRollupSQL = `
SELECT day, provider, model, department, calls, sum_tokens, sum_latency_ms, count_latency, p95_latency_ms
  FROM usage_daily_rollup
 WHERE org_id = $1 AND day >= $2 AND day <= $3`

// FetchRollupRows returns the pre-aggregated rows for a tenant whose day falls in
// the (UTC) date span of [From, To].
func (r *RollupRepository) FetchRollupRows(ctx context.Context, p domain.QueryParams) ([]domain.RollupRow, error) {
	rows, err := r.pool.Query(ctx, fetchRollupSQL, p.OrgID, p.From, p.To)
	if err != nil {
		return nil, fmt.Errorf("query rollup: %w", err)
	}
	defer rows.Close()

	out := make([]domain.RollupRow, 0, 256)
	for rows.Next() {
		var x domain.RollupRow
		if err := rows.Scan(&x.Day, &x.Provider, &x.Model, &x.Department,
			&x.Calls, &x.SumTokens, &x.SumLatencyMs, &x.CountLatency, &x.P95LatencyMs); err != nil {
			return nil, fmt.Errorf("scan rollup row: %w", err)
		}
		out = append(out, x)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rollup rows: %w", err)
	}
	return out, nil
}
