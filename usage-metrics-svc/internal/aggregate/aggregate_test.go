package aggregate

import (
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

func ptr(i int) *int { return &i }

func ts(y int, m time.Month, d, h int) time.Time {
	return time.Date(y, m, d, h, 0, 0, 0, time.UTC)
}

func TestAggregate(t *testing.T) {
	pricing := domain.DefaultPricing() // haiku 3.0, sonnet 9.0, opus 15.0 USD/MTok

	tests := []struct {
		name string
		rows []domain.UsageRow
		// expectations on the resulting report
		wantCalls       int
		wantTokens      int
		wantCostUSD     float64
		wantAvgLatency  int
		wantP95Latency  int
		wantBuckets     int
		wantUnknown     []string
		extraAssertions func(t *testing.T, r domain.UsageReport)
	}{
		{
			name:           "empty input yields zero everything",
			rows:           nil,
			wantCalls:      0,
			wantTokens:     0,
			wantCostUSD:    0,
			wantAvgLatency: 0,
			wantP95Latency: 0,
			wantBuckets:    0,
		},
		{
			name: "single row",
			rows: []domain.UsageRow{
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(500), CreatedAt: ts(2026, 6, 1, 9)},
			},
			wantCalls:      1,
			wantTokens:     1_000_000,
			wantCostUSD:    3.0, // 1M tokens * 3.0/MTok
			wantAvgLatency: 500,
			wantP95Latency: 500, // n=1 → the single value
			wantBuckets:    1,
		},
		{
			name: "multiple providers split into separate buckets",
			rows: []domain.UsageRow{
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(400), CreatedAt: ts(2026, 6, 1, 9)},
				{Department: "経理部", Provider: "openai", Model: "gpt-x", Tokens: ptr(2_000_000), LatencyMs: ptr(800), CreatedAt: ts(2026, 6, 1, 10)},
			},
			wantCalls:      2,
			wantTokens:     3_000_000,
			wantCostUSD:    3.0 + (2.0 * 9.0), // haiku 3.0 + unknown(openai)->fallback 9.0 *2M
			wantAvgLatency: 600,
			wantP95Latency: 800,
			wantBuckets:    2, // same day, two providers
			wantUnknown:    []string{"gpt-x"},
		},
		{
			name: "rows spanning multiple days bucket separately (期間またぎ)",
			rows: []domain.UsageRow{
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(100), CreatedAt: ts(2026, 6, 1, 23)},
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(1_000_000), LatencyMs: ptr(300), CreatedAt: ts(2026, 6, 2, 1)},
			},
			wantCalls:      2,
			wantTokens:     2_000_000,
			wantCostUSD:    6.0,
			wantAvgLatency: 200,
			wantP95Latency: 300,
			wantBuckets:    2, // two distinct UTC days, same provider
			extraAssertions: func(t *testing.T, r domain.UsageReport) {
				if r.ByDayProvider[0].Date != "2026-06-01" || r.ByDayProvider[1].Date != "2026-06-02" {
					t.Fatalf("expected day buckets sorted 06-01 then 06-02, got %q then %q",
						r.ByDayProvider[0].Date, r.ByDayProvider[1].Date)
				}
			},
		},
		{
			name: "nil tokens count as a call but contribute zero tokens and cost",
			rows: []domain.UsageRow{
				{Department: "経理部", Provider: "anthropic", Model: "claude-opus-4-8", Tokens: nil, LatencyMs: ptr(1000), CreatedAt: ts(2026, 6, 1, 9)},
			},
			wantCalls:      1,
			wantTokens:     0,
			wantCostUSD:    0,
			wantAvgLatency: 1000,
			wantP95Latency: 1000,
			wantBuckets:    1,
		},
		{
			name: "nil latency is excluded from avg/p95 denominators",
			rows: []domain.UsageRow{
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(0), LatencyMs: ptr(200), CreatedAt: ts(2026, 6, 1, 9)},
				{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(0), LatencyMs: nil, CreatedAt: ts(2026, 6, 1, 10)},
			},
			wantCalls:      2,
			wantTokens:     0,
			wantCostUSD:    0,
			wantAvgLatency: 200, // only the one non-nil latency
			wantP95Latency: 200,
			wantBuckets:    1,
		},
		{
			name:           "p95 nearest-rank over 20 values picks the 19th",
			rows:           latencyRows(20),
			wantCalls:      20,
			wantTokens:     0,
			wantCostUSD:    0,
			wantAvgLatency: 1050, // mean of 100..2000 step 100
			wantP95Latency: 1900, // ceil(0.95*20)=19 → sorted[18] = 1900
			wantBuckets:    1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Aggregate(tc.rows, pricing)

			if got.Totals.Calls != tc.wantCalls {
				t.Errorf("Calls = %d, want %d", got.Totals.Calls, tc.wantCalls)
			}
			if got.Totals.Tokens != tc.wantTokens {
				t.Errorf("Tokens = %d, want %d", got.Totals.Tokens, tc.wantTokens)
			}
			if !almostEqual(got.Totals.CostUSD, tc.wantCostUSD) {
				t.Errorf("CostUSD = %v, want %v", got.Totals.CostUSD, tc.wantCostUSD)
			}
			if got.Totals.AvgLatencyMs != tc.wantAvgLatency {
				t.Errorf("AvgLatencyMs = %d, want %d", got.Totals.AvgLatencyMs, tc.wantAvgLatency)
			}
			if got.Totals.P95LatencyMs != tc.wantP95Latency {
				t.Errorf("P95LatencyMs = %d, want %d", got.Totals.P95LatencyMs, tc.wantP95Latency)
			}
			if len(got.ByDayProvider) != tc.wantBuckets {
				t.Errorf("buckets = %d, want %d", len(got.ByDayProvider), tc.wantBuckets)
			}
			if tc.wantUnknown != nil {
				if len(got.UnknownModels) != len(tc.wantUnknown) {
					t.Fatalf("UnknownModels = %v, want %v", got.UnknownModels, tc.wantUnknown)
				}
				for i := range tc.wantUnknown {
					if got.UnknownModels[i] != tc.wantUnknown[i] {
						t.Errorf("UnknownModels[%d] = %q, want %q", i, got.UnknownModels[i], tc.wantUnknown[i])
					}
				}
			}
			if tc.extraAssertions != nil {
				tc.extraAssertions(t, got)
			}
		})
	}
}

// latencyRows builds n rows in one bucket with latencies 100,200,…,n*100.
func latencyRows(n int) []domain.UsageRow {
	rows := make([]domain.UsageRow, n)
	for i := 0; i < n; i++ {
		rows[i] = domain.UsageRow{
			Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5",
			Tokens: ptr(0), LatencyMs: ptr((i + 1) * 100), CreatedAt: ts(2026, 6, 1, 9),
		}
	}
	return rows
}

func TestAggregateDepartmentBreakdown(t *testing.T) {
	rows := []domain.UsageRow{
		{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(100), LatencyMs: ptr(1), CreatedAt: ts(2026, 6, 1, 9)},
		{Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(100), LatencyMs: ptr(1), CreatedAt: ts(2026, 6, 1, 9)},
		{Department: "経理部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptr(100), LatencyMs: ptr(1), CreatedAt: ts(2026, 6, 1, 9)},
	}
	got := Aggregate(rows, domain.DefaultPricing())
	if len(got.ByDepartment) != 2 {
		t.Fatalf("departments = %d, want 2", len(got.ByDepartment))
	}
	// Sorted by calls desc: 営業部 (2) before 経理部 (1).
	if got.ByDepartment[0].Department != "営業部" || got.ByDepartment[0].Calls != 2 {
		t.Errorf("top department = %+v, want 営業部 with 2 calls", got.ByDepartment[0])
	}
}

func almostEqual(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-6
}
