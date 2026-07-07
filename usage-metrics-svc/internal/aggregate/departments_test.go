package aggregate

import (
	"reflect"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

func dts(d int) time.Time {
	return time.Date(2026, time.June, d, 9, 0, 0, 0, time.UTC)
}

func TestAggregateDepartments(t *testing.T) {
	pricing := domain.DefaultPricing() // haiku 3.0, sonnet 9.0, opus 15.0 USD/MTok; fallback 9.0

	tests := []struct {
		name        string
		rows        []domain.UsageRow
		want        []domain.DepartmentKpi
		wantUnknown []string
	}{
		{
			name:        "empty input yields empty departments",
			rows:        nil,
			want:        []domain.DepartmentKpi{},
			wantUnknown: []string{},
		},
		{
			name: "single department, nil latency excluded from avg/p95 denominators",
			rows: []domain.UsageRow{
				{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(400), CreatedAt: dts(1)},
				{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: nil, CreatedAt: dts(1)},
				{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(800), CreatedAt: dts(2)},
			},
			want: []domain.DepartmentKpi{
				// 3 calls (nil latency row still counts), 3M tokens * 3.0/MTok = 9.0,
				// avg = (400+800)/2 = 600, p95 (n=2, nearest-rank) = 800.
				{Department: "SALES", Calls: 3, Tokens: 3_000_000, CostUSD: 9.0, AvgLatencyMs: 600, P95LatencyMs: 800},
			},
			wantUnknown: []string{},
		},
		{
			name: "nil tokens contribute 0 tokens and 0 cost but count as a call",
			rows: []domain.UsageRow{
				{Department: "ACCOUNTING", Model: "claude-opus-4-8", Tokens: nil, LatencyMs: ptr(1500), CreatedAt: dts(1)},
			},
			want: []domain.DepartmentKpi{
				{Department: "ACCOUNTING", Calls: 1, Tokens: 0, CostUSD: 0, AvgLatencyMs: 1500, P95LatencyMs: 1500},
			},
			wantUnknown: []string{},
		},
		{
			name: "multiple departments sorted by calls desc then name asc; unknown model reported",
			rows: []domain.UsageRow{
				{Department: "MARKETING", Model: "claude-sonnet-4-6", Tokens: ptr(2_000_000), LatencyMs: ptr(1000), CreatedAt: dts(1)},
				{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(200), CreatedAt: dts(1)},
				{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(400), CreatedAt: dts(2)},
				{Department: "GENERAL", Model: "gpt-x", Tokens: ptr(1_000_000), LatencyMs: ptr(700), CreatedAt: dts(3)},
			},
			want: []domain.DepartmentKpi{
				// SALES: 2 calls first; MARKETING/GENERAL tie at 1 call → name asc.
				{Department: "SALES", Calls: 2, Tokens: 2_000_000, CostUSD: 6.0, AvgLatencyMs: 300, P95LatencyMs: 400},
				{Department: "GENERAL", Calls: 1, Tokens: 1_000_000, CostUSD: 9.0, AvgLatencyMs: 700, P95LatencyMs: 700}, // fallback rate
				{Department: "MARKETING", Calls: 1, Tokens: 2_000_000, CostUSD: 18.0, AvgLatencyMs: 1000, P95LatencyMs: 1000},
			},
			wantUnknown: []string{"gpt-x"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unknown := AggregateDepartments(tt.rows, pricing)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("departments mismatch\n got: %+v\nwant: %+v", got, tt.want)
			}
			if !reflect.DeepEqual(unknown, tt.wantUnknown) {
				t.Errorf("unknownModels = %v, want %v", unknown, tt.wantUnknown)
			}
		})
	}
}

// TestAggregateDepartmentsMatchesAggregateByDepartment pins the invariant that
// the dedicated departments view never drifts from UsageReport.ByDepartment on
// the shared fields (calls / tokens / cost).
func TestAggregateDepartmentsMatchesAggregateByDepartment(t *testing.T) {
	pricing := domain.DefaultPricing()
	rows := []domain.UsageRow{
		{Department: "SALES", Model: "claude-haiku-4-5", Tokens: ptr(1_200_000), LatencyMs: ptr(300), CreatedAt: dts(1)},
		{Department: "MARKETING", Model: "claude-sonnet-4-6", Tokens: nil, LatencyMs: ptr(900), CreatedAt: dts(2)},
		{Department: "SALES", Model: "unknown-model", Tokens: ptr(500_000), LatencyMs: nil, CreatedAt: dts(3)},
	}

	report := Aggregate(rows, pricing)
	depts, unknown := AggregateDepartments(rows, pricing)

	if len(depts) != len(report.ByDepartment) {
		t.Fatalf("length mismatch: departments=%d byDepartment=%d", len(depts), len(report.ByDepartment))
	}
	for i, d := range depts {
		b := report.ByDepartment[i]
		if d.Department != b.Department || d.Calls != b.Calls || d.Tokens != b.Tokens || d.CostUSD != b.CostUSD {
			t.Errorf("row %d drifted from ByDepartment\n got: %+v\nwant: %+v", i, d, b)
		}
	}
	if !reflect.DeepEqual(unknown, report.UnknownModels) {
		t.Errorf("unknownModels = %v, want %v", unknown, report.UnknownModels)
	}
}
