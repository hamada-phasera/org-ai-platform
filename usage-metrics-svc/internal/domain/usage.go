// Package domain holds the core data types for usage-metrics-svc.
//
// The single source of truth is org-ai-platform's "AILog" table, which this
// service reads but NEVER writes. Column quirks preserved here intentionally:
//   - tenant identifier is orgId (not tenant_id)
//   - tokens is a single combined input+output total, and is nullable
//   - latencyMs is nullable
//   - createdAt is `timestamp without time zone`; we treat it as UTC throughout
package domain

import "time"

// UsageRow is one AILog row projected to the fields metrics needs.
type UsageRow struct {
	OrgID      string
	Department string
	Provider   string
	Model      string
	Tokens     *int      // AILog.tokens — nullable; combined input+output total
	LatencyMs  *int      // AILog."latencyMs" — nullable
	CreatedAt  time.Time // AILog."createdAt" — timestamp w/o tz, treated as UTC
}

// QueryParams selects rows for a single tenant over a half-open [From, To) window.
// A zero From or To bound is treated as unbounded by the repository.
type QueryParams struct {
	OrgID string
	From  time.Time
	To    time.Time
}

// DayProviderBucket is the per-(UTC day, provider) aggregate — the core grain
// requested by the plan ("day/provider 別に cost合計・calls・avg/p95 latency").
type DayProviderBucket struct {
	Date         string  `json:"date"` // YYYY-MM-DD (UTC)
	Provider     string  `json:"provider"`
	Calls        int     `json:"calls"`
	Tokens       int     `json:"tokens"`
	CostUSD      float64 `json:"costUsd"`
	AvgLatencyMs int     `json:"avgLatencyMs"`
	P95LatencyMs int     `json:"p95LatencyMs"`
}

// DepartmentUsage is a per-department breakdown (bonus dimension AILog carries:
// 営業部 / SNSマーケ部 / 経理部 …). Mirrors the existing /governance/stats endpoint
// so this service is a drop-in superset.
type DepartmentUsage struct {
	Department string  `json:"department"`
	Calls      int     `json:"calls"`
	Tokens     int     `json:"tokens"`
	CostUSD    float64 `json:"costUsd"`
}

// Totals are the window-wide aggregates across every returned row.
type Totals struct {
	Calls        int     `json:"calls"`
	Tokens       int     `json:"tokens"`
	CostUSD      float64 `json:"costUsd"`
	AvgLatencyMs int     `json:"avgLatencyMs"`
	P95LatencyMs int     `json:"p95LatencyMs"`
}

// UsageReport is the payload for GET /metrics/usage.
type UsageReport struct {
	TenantID      string              `json:"tenantId"`
	From          time.Time           `json:"from"`
	To            time.Time           `json:"to"`
	Totals        Totals              `json:"totals"`
	ByDayProvider []DayProviderBucket `json:"byDayProvider"`
	ByDepartment  []DepartmentUsage   `json:"byDepartment"`
	// UnknownModels lists model ids that had no price entry (cost used the
	// fallback rate). Surfaced for honesty rather than hidden.
	UnknownModels []string `json:"unknownModels,omitempty"`
}
