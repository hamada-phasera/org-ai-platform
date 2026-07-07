package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AILog identifiers, centralized so a schema rename is a one-line change. They
// are quoted because the table uses PascalCase / camelCase identifiers.
const (
	tableAILog    = `"AILog"`
	colOrgID      = `"orgId"`
	colDepartment = `department`
	colProvider   = `provider`
	colModel      = `model`
	colTokens     = `tokens`
	colLatencyMs  = `"latencyMs"`
	colCreatedAt  = `"createdAt"`
)

// fetchUsageSQL selects exactly the columns metrics needs, for one tenant over a
// half-open [from, to) window. Values are bound as parameters ($1/$2/$3) — never
// interpolated — so it is injection-safe.
var fetchUsageSQL = fmt.Sprintf(
	`SELECT %s, %s, %s, %s, %s, %s, %s
       FROM %s
      WHERE %s = $1 AND %s >= $2 AND %s < $3`,
	colOrgID, colDepartment, colProvider, colModel, colTokens, colLatencyMs, colCreatedAt,
	tableAILog,
	colOrgID, colCreatedAt, colCreatedAt,
)

// PgxRepository reads AILog rows from Postgres. Every fetch runs inside a READ
// ONLY transaction, so the serving path is structurally incapable of writing to
// the org-ai-platform database — the "never writes AILog" contract is enforced
// by the DB, not just by convention.
type PgxRepository struct {
	pool *pgxpool.Pool
}

// NewPgxRepository wraps a pgx pool.
func NewPgxRepository(pool *pgxpool.Pool) *PgxRepository {
	return &PgxRepository{pool: pool}
}

// FetchUsageRows runs the parameterized SELECT inside a read-only transaction.
func (r *PgxRepository) FetchUsageRows(ctx context.Context, p domain.QueryParams) ([]domain.UsageRow, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin read-only tx: %w", err)
	}
	defer tx.Rollback(ctx) // read-only ⇒ nothing to commit; rollback releases the conn

	rows, err := tx.Query(ctx, fetchUsageSQL, p.OrgID, p.From, p.To)
	if err != nil {
		return nil, fmt.Errorf("query AILog: %w", err)
	}
	defer rows.Close()

	out := make([]domain.UsageRow, 0, 256)
	for rows.Next() {
		var u domain.UsageRow
		// tokens / latencyMs are nullable → scanned into *int (nil for NULL).
		// createdAt is `timestamp without time zone`; pgx yields a UTC time.Time,
		// which matches the UTC day-bucketing in the aggregation layer.
		if err := rows.Scan(&u.OrgID, &u.Department, &u.Provider, &u.Model,
			&u.Tokens, &u.LatencyMs, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan AILog row: %w", err)
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate AILog rows: %w", err)
	}
	return out, nil
}

// NewPool builds and verifies a pgx pool from a DSN.
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 8
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return pool, nil
}
