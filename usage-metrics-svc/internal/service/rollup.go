package service

import (
	"context"
	"math"
	"sort"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

// RollupSource supplies pre-aggregated rollup rows for a tenant + window.
// Implemented by repository.RollupRepository.
type RollupSource interface {
	FetchRollupRows(ctx context.Context, p domain.QueryParams) ([]domain.RollupRow, error)
}

// RollupService serves usage reports from usage_daily_rollup (the fast path).
// It reproduces the raw read path EXACTLY for calls / tokens / cost / avg
// latency; window and per-bucket p95 are approximate (max of the component
// per-grain p95s — see DESIGN.md).
type RollupService struct {
	source  RollupSource
	pricing domain.Pricing
}

// NewRollup builds a RollupService.
func NewRollup(source RollupSource, pricing domain.Pricing) *RollupService {
	return &RollupService{source: source, pricing: pricing}
}

// GetUsage satisfies the same contract as service.Service.GetUsage.
func (s *RollupService) GetUsage(ctx context.Context, p domain.QueryParams) (domain.UsageReport, error) {
	rows, err := s.source.FetchRollupRows(ctx, p)
	if err != nil {
		return domain.UsageReport{}, err
	}
	report := buildReportFromRollup(rows, s.pricing)
	report.TenantID = p.OrgID
	report.From = p.From
	report.To = p.To
	return report, nil
}

// GetDepartments satisfies the same contract as service.Service.GetDepartments,
// reading from usage_daily_rollup. calls / tokens / cost / avg latency are
// exact; per-department p95 is approximate (max of the component per-grain
// p95s — the same convention GetUsage uses, see DESIGN.md).
func (s *RollupService) GetDepartments(ctx context.Context, p domain.QueryParams) (domain.DepartmentsReport, error) {
	rows, err := s.source.FetchRollupRows(ctx, p)
	if err != nil {
		return domain.DepartmentsReport{}, err
	}

	type deptKpiAgg struct {
		calls      int
		tokens     int64
		cost       float64
		sumLatency int64
		cntLatency int
		p95Max     int
	}
	dept := map[string]*deptKpiAgg{}
	unknown := map[string]struct{}{}

	for _, r := range rows {
		// cost is linear in tokens, so cost over a grain's token sum equals the
		// sum of per-row costs — exact, not an approximation.
		cost, known := s.pricing.CostUSD(r.Model, int(r.SumTokens))
		if !known {
			unknown[r.Model] = struct{}{}
		}
		d := dept[r.Department]
		if d == nil {
			d = &deptKpiAgg{}
			dept[r.Department] = d
		}
		d.calls += r.Calls
		d.tokens += r.SumTokens
		d.cost += cost
		d.sumLatency += r.SumLatencyMs
		d.cntLatency += r.CountLatency
		if r.P95LatencyMs > d.p95Max {
			d.p95Max = r.P95LatencyMs
		}
	}

	depts := make([]domain.DepartmentKpi, 0, len(dept))
	for name, d := range dept {
		depts = append(depts, domain.DepartmentKpi{
			Department:   name,
			Calls:        d.calls,
			Tokens:       int(d.tokens),
			CostUSD:      round6(d.cost),
			AvgLatencyMs: meanFromSum(d.sumLatency, d.cntLatency),
			P95LatencyMs: d.p95Max,
		})
	}
	sort.Slice(depts, func(i, j int) bool {
		if depts[i].Calls != depts[j].Calls {
			return depts[i].Calls > depts[j].Calls
		}
		return depts[i].Department < depts[j].Department
	})

	unknownModels := make([]string, 0, len(unknown))
	for m := range unknown {
		unknownModels = append(unknownModels, m)
	}
	sort.Strings(unknownModels)

	return domain.DepartmentsReport{
		TenantID:      p.OrgID,
		From:          p.From,
		To:            p.To,
		Departments:   depts,
		UnknownModels: unknownModels,
	}, nil
}

type dpAgg struct {
	calls      int
	tokens     int64
	cost       float64
	sumLatency int64
	cntLatency int
	p95Max     int
}

type deptAgg struct {
	calls  int
	tokens int64
	cost   float64
}

func buildReportFromRollup(rows []domain.RollupRow, pricing domain.Pricing) domain.UsageReport {
	type dpKey struct{ date, provider string }

	dp := map[dpKey]*dpAgg{}
	dept := map[string]*deptAgg{}
	unknown := map[string]struct{}{}

	var totalCalls int
	var totalTokens int64
	var totalCost float64
	var totalSumLat int64
	var totalCntLat, totalP95Max int

	for _, r := range rows {
		date := r.Day.UTC().Format("2006-01-02")
		// cost is linear in tokens, so cost over a grain's token sum equals the
		// sum of per-row costs — exact, not an approximation.
		cost, known := pricing.CostUSD(r.Model, int(r.SumTokens))
		if !known {
			unknown[r.Model] = struct{}{}
		}

		k := dpKey{date: date, provider: r.Provider}
		a := dp[k]
		if a == nil {
			a = &dpAgg{}
			dp[k] = a
		}
		a.calls += r.Calls
		a.tokens += r.SumTokens
		a.cost += cost
		a.sumLatency += r.SumLatencyMs
		a.cntLatency += r.CountLatency
		if r.P95LatencyMs > a.p95Max {
			a.p95Max = r.P95LatencyMs
		}

		d := dept[r.Department]
		if d == nil {
			d = &deptAgg{}
			dept[r.Department] = d
		}
		d.calls += r.Calls
		d.tokens += r.SumTokens
		d.cost += cost

		totalCalls += r.Calls
		totalTokens += r.SumTokens
		totalCost += cost
		totalSumLat += r.SumLatencyMs
		totalCntLat += r.CountLatency
		if r.P95LatencyMs > totalP95Max {
			totalP95Max = r.P95LatencyMs
		}
	}

	buckets := make([]domain.DayProviderBucket, 0, len(dp))
	for k, a := range dp {
		buckets = append(buckets, domain.DayProviderBucket{
			Date:         k.date,
			Provider:     k.provider,
			Calls:        a.calls,
			Tokens:       int(a.tokens),
			CostUSD:      round6(a.cost),
			AvgLatencyMs: meanFromSum(a.sumLatency, a.cntLatency),
			P95LatencyMs: a.p95Max,
		})
	}
	sort.Slice(buckets, func(i, j int) bool {
		if buckets[i].Date != buckets[j].Date {
			return buckets[i].Date < buckets[j].Date
		}
		return buckets[i].Provider < buckets[j].Provider
	})

	depts := make([]domain.DepartmentUsage, 0, len(dept))
	for name, d := range dept {
		depts = append(depts, domain.DepartmentUsage{
			Department: name,
			Calls:      d.calls,
			Tokens:     int(d.tokens),
			CostUSD:    round6(d.cost),
		})
	}
	sort.Slice(depts, func(i, j int) bool {
		if depts[i].Calls != depts[j].Calls {
			return depts[i].Calls > depts[j].Calls
		}
		return depts[i].Department < depts[j].Department
	})

	unknownModels := make([]string, 0, len(unknown))
	for m := range unknown {
		unknownModels = append(unknownModels, m)
	}
	sort.Strings(unknownModels)

	return domain.UsageReport{
		Totals: domain.Totals{
			Calls:        totalCalls,
			Tokens:       int(totalTokens),
			CostUSD:      round6(totalCost),
			AvgLatencyMs: meanFromSum(totalSumLat, totalCntLat),
			P95LatencyMs: totalP95Max,
		},
		ByDayProvider: buckets,
		ByDepartment:  depts,
		UnknownModels: unknownModels,
	}
}

func meanFromSum(sum int64, n int) int {
	if n == 0 {
		return 0
	}
	return int(math.Round(float64(sum) / float64(n)))
}

func round6(x float64) float64 {
	return math.Round(x*1e6) / 1e6
}
