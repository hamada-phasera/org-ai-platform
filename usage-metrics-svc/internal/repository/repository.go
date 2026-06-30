// Package repository is the read-only access layer for AILog rows. There are two
// implementations: an in-memory fake (this file's neighbour, for tests/dev) and
// a Postgres/pgx reader added in PHASE 3. Column names are centralized in the
// pgx reader so a schema rename is a one-line change.
package repository

import (
	"context"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

// UsageRepository returns the raw rows for a tenant + time window. It is the only
// seam between aggregation logic and the data source.
type UsageRepository interface {
	FetchUsageRows(ctx context.Context, p domain.QueryParams) ([]domain.UsageRow, error)
}
