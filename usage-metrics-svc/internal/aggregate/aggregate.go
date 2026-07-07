// Package aggregate reduces raw AILog rows into a UsageReport. The core function
// is pure and deterministic — the repository decides which rows (tenant + time
// window) to pass in, so this logic is trivially table-driven testable.
package aggregate

import (
	"sort"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

// Aggregate computes per-(UTC day, provider) buckets, a per-department breakdown,
// and window-wide totals.
//
// Null handling (AILog.tokens / latencyMs are nullable):
//   - a row always counts as one call;
//   - nil tokens contribute 0 tokens and 0 cost;
//   - nil latency is excluded from the avg and p95 denominators.
func Aggregate(rows []domain.UsageRow, pricing domain.Pricing) domain.UsageReport {
	type dpKey struct{ date, provider string }

	dpCalls := map[dpKey]int{}
	dpTokens := map[dpKey]int{}
	dpCost := map[dpKey]float64{}
	dpLat := map[dpKey][]int{}

	deptCalls := map[string]int{}
	deptTokens := map[string]int{}
	deptCost := map[string]float64{}

	var totalCost float64
	totalTokens := 0
	allLat := make([]int, 0, len(rows))
	unknown := map[string]struct{}{}

	for _, r := range rows {
		date := r.CreatedAt.UTC().Format("2006-01-02")
		k := dpKey{date: date, provider: r.Provider}

		tokens := 0
		if r.Tokens != nil && *r.Tokens > 0 {
			tokens = *r.Tokens
		}
		cost, known := pricing.CostUSD(r.Model, tokens)
		if !known {
			unknown[r.Model] = struct{}{}
		}

		dpCalls[k]++
		dpTokens[k] += tokens
		dpCost[k] += cost
		if r.LatencyMs != nil {
			dpLat[k] = append(dpLat[k], *r.LatencyMs)
			allLat = append(allLat, *r.LatencyMs)
		}

		deptCalls[r.Department]++
		deptTokens[r.Department] += tokens
		deptCost[r.Department] += cost

		totalTokens += tokens
		totalCost += cost
	}

	// Buckets, sorted by (date asc, provider asc) for stable output.
	buckets := make([]domain.DayProviderBucket, 0, len(dpCalls))
	for k := range dpCalls {
		buckets = append(buckets, domain.DayProviderBucket{
			Date:         k.date,
			Provider:     k.provider,
			Calls:        dpCalls[k],
			Tokens:       dpTokens[k],
			CostUSD:      round6(dpCost[k]),
			AvgLatencyMs: meanInt(dpLat[k]),
			P95LatencyMs: percentileInt(dpLat[k], 0.95),
		})
	}
	sort.Slice(buckets, func(i, j int) bool {
		if buckets[i].Date != buckets[j].Date {
			return buckets[i].Date < buckets[j].Date
		}
		return buckets[i].Provider < buckets[j].Provider
	})

	// Departments, sorted by calls desc then name asc.
	depts := make([]domain.DepartmentUsage, 0, len(deptCalls))
	for d := range deptCalls {
		depts = append(depts, domain.DepartmentUsage{
			Department: d,
			Calls:      deptCalls[d],
			Tokens:     deptTokens[d],
			CostUSD:    round6(deptCost[d]),
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
			Calls:        len(rows),
			Tokens:       totalTokens,
			CostUSD:      round6(totalCost),
			AvgLatencyMs: meanInt(allLat),
			P95LatencyMs: percentileInt(allLat, 0.95),
		},
		ByDayProvider: buckets,
		ByDepartment:  depts,
		UnknownModels: unknownModels,
	}
}

// AggregateDepartments reduces raw AILog rows into per-department KPI rows for
// GET /metrics/departments. Same null-handling contract as Aggregate:
//   - a row always counts as one call;
//   - nil tokens contribute 0 tokens and 0 cost;
//   - nil latency is excluded from the avg and p95 denominators.
//
// Departments are sorted by calls desc then name asc (same convention as
// UsageReport.ByDepartment). The second return value lists model ids that had
// no price entry (cost used the fallback rate).
func AggregateDepartments(rows []domain.UsageRow, pricing domain.Pricing) ([]domain.DepartmentKpi, []string) {
	deptCalls := map[string]int{}
	deptTokens := map[string]int{}
	deptCost := map[string]float64{}
	deptLat := map[string][]int{}
	unknown := map[string]struct{}{}

	for _, r := range rows {
		tokens := 0
		if r.Tokens != nil && *r.Tokens > 0 {
			tokens = *r.Tokens
		}
		cost, known := pricing.CostUSD(r.Model, tokens)
		if !known {
			unknown[r.Model] = struct{}{}
		}

		deptCalls[r.Department]++
		deptTokens[r.Department] += tokens
		deptCost[r.Department] += cost
		if r.LatencyMs != nil {
			deptLat[r.Department] = append(deptLat[r.Department], *r.LatencyMs)
		}
	}

	depts := make([]domain.DepartmentKpi, 0, len(deptCalls))
	for d := range deptCalls {
		depts = append(depts, domain.DepartmentKpi{
			Department:   d,
			Calls:        deptCalls[d],
			Tokens:       deptTokens[d],
			CostUSD:      round6(deptCost[d]),
			AvgLatencyMs: meanInt(deptLat[d]),
			P95LatencyMs: percentileInt(deptLat[d], 0.95),
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

	return depts, unknownModels
}
