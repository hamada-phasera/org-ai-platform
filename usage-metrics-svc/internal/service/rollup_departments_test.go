package service

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

// fakeRollupSource returns a fixed set of rollup rows.
type fakeRollupSource struct {
	rows []domain.RollupRow
}

func (f fakeRollupSource) FetchRollupRows(_ context.Context, _ domain.QueryParams) ([]domain.RollupRow, error) {
	return f.rows, nil
}

func day(d int) time.Time {
	return time.Date(2026, time.June, d, 0, 0, 0, 0, time.UTC)
}

func TestRollupGetDepartments(t *testing.T) {
	pricing := domain.DefaultPricing() // haiku 3.0, sonnet 9.0 USD/MTok

	rows := []domain.RollupRow{
		// SALES over two days / one model. avg latency from sums is exact:
		// (1200+800)/(3+1) = 500. p95 = max(700, 900) = 900 (approximation rule).
		{Day: day(1), Provider: "anthropic", Model: "claude-haiku-4-5", Department: "SALES", Calls: 3, SumTokens: 1_000_000, SumLatencyMs: 1200, CountLatency: 3, P95LatencyMs: 700},
		{Day: day(2), Provider: "anthropic", Model: "claude-haiku-4-5", Department: "SALES", Calls: 1, SumTokens: 2_000_000, SumLatencyMs: 800, CountLatency: 1, P95LatencyMs: 900},
		// MARKETING single grain row.
		{Day: day(1), Provider: "anthropic", Model: "claude-sonnet-4-6", Department: "MARKETING", Calls: 2, SumTokens: 1_000_000, SumLatencyMs: 3000, CountLatency: 2, P95LatencyMs: 2000},
	}

	svc := NewRollup(fakeRollupSource{rows: rows}, pricing)
	got, err := svc.GetDepartments(context.Background(), domain.QueryParams{OrgID: "demo-org", From: day(1), To: day(3)})
	if err != nil {
		t.Fatalf("GetDepartments: %v", err)
	}

	if got.TenantID != "demo-org" {
		t.Errorf("tenantId = %q, want demo-org", got.TenantID)
	}
	want := []domain.DepartmentKpi{
		// SALES: 4 calls, 3M tokens haiku → 9.0 USD.
		{Department: "SALES", Calls: 4, Tokens: 3_000_000, CostUSD: 9.0, AvgLatencyMs: 500, P95LatencyMs: 900},
		// MARKETING: 2 calls, 1M tokens sonnet → 9.0 USD, avg 1500.
		{Department: "MARKETING", Calls: 2, Tokens: 1_000_000, CostUSD: 9.0, AvgLatencyMs: 1500, P95LatencyMs: 2000},
	}
	if !reflect.DeepEqual(got.Departments, want) {
		t.Errorf("departments mismatch\n got: %+v\nwant: %+v", got.Departments, want)
	}
	if len(got.UnknownModels) != 0 {
		t.Errorf("unknownModels = %v, want empty", got.UnknownModels)
	}
}

func TestRollupGetDepartmentsEmpty(t *testing.T) {
	svc := NewRollup(fakeRollupSource{}, domain.DefaultPricing())
	got, err := svc.GetDepartments(context.Background(), domain.QueryParams{OrgID: "demo-org"})
	if err != nil {
		t.Fatalf("GetDepartments: %v", err)
	}
	if len(got.Departments) != 0 {
		t.Errorf("departments = %+v, want empty", got.Departments)
	}
}
