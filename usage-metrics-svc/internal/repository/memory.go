package repository

import (
	"context"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

// MemoryRepository is an in-memory UsageRepository for tests and local dev.
type MemoryRepository struct {
	rows []domain.UsageRow
}

// NewMemoryRepository wraps a fixed set of rows.
func NewMemoryRepository(rows []domain.UsageRow) *MemoryRepository {
	return &MemoryRepository{rows: rows}
}

// FetchUsageRows returns rows for the given tenant whose CreatedAt is in
// [From, To). Zero From/To bounds are treated as unbounded. This mirrors the SQL
// the pgx reader will run, so aggregation behaves identically against either.
func (m *MemoryRepository) FetchUsageRows(_ context.Context, p domain.QueryParams) ([]domain.UsageRow, error) {
	out := make([]domain.UsageRow, 0, len(m.rows))
	for _, r := range m.rows {
		if p.OrgID != "" && r.OrgID != p.OrgID {
			continue
		}
		if !p.From.IsZero() && r.CreatedAt.Before(p.From) {
			continue
		}
		if !p.To.IsZero() && !r.CreatedAt.Before(p.To) { // r >= To is excluded (half-open)
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func ptrInt(i int) *int { return &i }

// SeedRows returns a small deterministic dataset so `curl /metrics/usage`
// returns realistic JSON without a database. Timestamps are anchored at fixed
// offsets BEFORE `now` so the data always lands inside the default 30-day window
// regardless of wall-clock time. Includes a second org and rows with nil tokens
// / nil latency to exercise the null paths.
func SeedRows(now time.Time) []domain.UsageRow {
	ago := func(h time.Duration) time.Time { return now.UTC().Add(-h * time.Hour) }
	return []domain.UsageRow{
		{OrgID: "demo-org", Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptrInt(1200), LatencyMs: ptrInt(840), CreatedAt: ago(2)},
		{OrgID: "demo-org", Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptrInt(2200), LatencyMs: ptrInt(910), CreatedAt: ago(3)},
		{OrgID: "demo-org", Department: "SNSマーケ部", Provider: "anthropic", Model: "claude-sonnet-4-6", Tokens: ptrInt(5400), LatencyMs: ptrInt(2300), CreatedAt: ago(4)},
		{OrgID: "demo-org", Department: "経理部", Provider: "anthropic", Model: "claude-opus-4-8", Tokens: ptrInt(8800), LatencyMs: ptrInt(5200), CreatedAt: ago(26)},
		{OrgID: "demo-org", Department: "経理部", Provider: "anthropic", Model: "claude-sonnet-4-6", Tokens: nil, LatencyMs: ptrInt(1500), CreatedAt: ago(27)},
		{OrgID: "demo-org", Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptrInt(900), LatencyMs: nil, CreatedAt: ago(50)},
		{OrgID: "other-org", Department: "営業部", Provider: "anthropic", Model: "claude-haiku-4-5", Tokens: ptrInt(9999), LatencyMs: ptrInt(700), CreatedAt: ago(2)},
	}
}
