package repository

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPgxRepositoryIntegration runs only when TEST_DATABASE_URL points at a
// Postgres branch seeded with AILog rows (see schema.sql / README). It is
// skipped in normal unit runs so `go test ./...` needs no database.
func TestPgxRepositoryIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping pgx integration test")
	}
	ctx := context.Background()
	pool, err := NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	repo := NewPgxRepository(pool)
	rows, err := repo.FetchUsageRows(ctx, domain.QueryParams{
		OrgID: "org-5",
		From:  time.Now().UTC().AddDate(0, 0, -30),
		To:    time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected rows for org-5 in the last 30 days")
	}

	sawTokens, sawLatency, sawNilTokens := false, false, false
	for _, r := range rows {
		if r.OrgID != "org-5" {
			t.Fatalf("tenant leak: got orgId=%q, want org-5", r.OrgID)
		}
		if r.Tokens != nil {
			sawTokens = true
		} else {
			sawNilTokens = true
		}
		if r.LatencyMs != nil {
			sawLatency = true
		}
	}
	if !sawTokens || !sawLatency {
		t.Errorf("expected some non-null tokens and latency; tokens=%v latency=%v", sawTokens, sawLatency)
	}
	t.Logf("fetched %d rows for org-5; observed null tokens: %v", len(rows), sawNilTokens)
}

// TestPgxReadOnlyTxRejectsWrites proves the serving path's safety mechanism: a
// write attempted inside the same read-only transaction mode the repository uses
// is rejected by Postgres (SQLSTATE 25006), so the reader cannot mutate AILog
// even with an owner DSN.
func TestPgxReadOnlyTxRejectsWrites(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping read-only enforcement test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("begin read-only tx: %v", err)
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `INSERT INTO "AILog" (id, "orgId", department, provider, model, "inputText", "createdAt") VALUES ('probe','probe','probe','probe','probe','probe', NOW())`)
	if err == nil {
		t.Fatal("expected the read-only transaction to reject the INSERT, but it succeeded")
	}
	t.Logf("write correctly rejected in read-only tx: %v", err)
}
