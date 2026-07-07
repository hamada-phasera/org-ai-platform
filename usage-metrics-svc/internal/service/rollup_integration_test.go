package service

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
)

// TestRollupMatchesRawIntegration proves the rollup read path reproduces the raw
// read path EXACTLY for the composable fields (calls / tokens / cost / avg
// latency and the per-department breakdown). It runs only with TEST_DATABASE_URL.
//
// A very wide window is used so no partial boundary day differs between the
// timestamp-precise raw read and the day-grain rollup read.
func TestRollupMatchesRawIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping rollup-vs-raw parity test")
	}
	ctx := context.Background()
	pool, err := repository.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	rollupRepo := repository.NewRollupRepository(pool)
	if _, err := rollupRepo.RefreshRollup(ctx, 200); err != nil {
		t.Fatalf("refresh rollup: %v", err)
	}

	pricing := domain.DefaultPricing()
	raw := New(repository.NewPgxRepository(pool), pricing)
	rollup := NewRollup(rollupRepo, pricing)

	p := domain.QueryParams{
		OrgID: "org-5",
		From:  time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		To:    time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	rRaw, err := raw.GetUsage(ctx, p)
	if err != nil {
		t.Fatalf("raw GetUsage: %v", err)
	}
	rRoll, err := rollup.GetUsage(ctx, p)
	if err != nil {
		t.Fatalf("rollup GetUsage: %v", err)
	}

	// Composable totals must match exactly.
	if rRaw.Totals.Calls != rRoll.Totals.Calls {
		t.Errorf("calls: raw=%d rollup=%d", rRaw.Totals.Calls, rRoll.Totals.Calls)
	}
	if rRaw.Totals.Tokens != rRoll.Totals.Tokens {
		t.Errorf("tokens: raw=%d rollup=%d", rRaw.Totals.Tokens, rRoll.Totals.Tokens)
	}
	if !almostEqualUSD(rRaw.Totals.CostUSD, rRoll.Totals.CostUSD) {
		t.Errorf("cost: raw=%.6f rollup=%.6f", rRaw.Totals.CostUSD, rRoll.Totals.CostUSD)
	}
	if rRaw.Totals.AvgLatencyMs != rRoll.Totals.AvgLatencyMs {
		t.Errorf("avgLatency: raw=%d rollup=%d", rRaw.Totals.AvgLatencyMs, rRoll.Totals.AvgLatencyMs)
	}

	// Per-department breakdown must match exactly (same set + same sums).
	rawDept := indexDepartments(rRaw.ByDepartment)
	rollDept := indexDepartments(rRoll.ByDepartment)
	if len(rawDept) != len(rollDept) {
		t.Fatalf("department count: raw=%d rollup=%d", len(rawDept), len(rollDept))
	}
	for name, a := range rawDept {
		b, ok := rollDept[name]
		if !ok {
			t.Errorf("department %q missing in rollup", name)
			continue
		}
		if a.Calls != b.Calls || a.Tokens != b.Tokens || !almostEqualUSD(a.CostUSD, b.CostUSD) {
			t.Errorf("department %q: raw=%+v rollup=%+v", name, a, b)
		}
	}

	// p95 is approximate from the rollup (max of per-grain p95). Don't assert
	// equality — just record both so the gap is visible.
	t.Logf("p95 latency: raw(exact)=%d rollup(approx)=%d", rRaw.Totals.P95LatencyMs, rRoll.Totals.P95LatencyMs)
	if rRoll.Totals.P95LatencyMs <= 0 {
		t.Errorf("rollup p95 should be positive, got %d", rRoll.Totals.P95LatencyMs)
	}
}

func indexDepartments(ds []domain.DepartmentUsage) map[string]domain.DepartmentUsage {
	m := make(map[string]domain.DepartmentUsage, len(ds))
	for _, d := range ds {
		m[d.Department] = d
	}
	return m
}

func almostEqualUSD(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-4
}
