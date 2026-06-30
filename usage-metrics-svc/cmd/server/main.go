// Command server runs usage-metrics-svc.
//
// PHASE 1/2: it serves aggregated KPIs from an in-memory repository seeded with
// demo data, so `curl localhost:8080/metrics/usage?tenant_id=demo-org` returns
// realistic JSON with no database. PHASE 3 swaps in the Postgres reader.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/httpapi"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
	"github.com/hamada-phasera/usage-metrics-svc/internal/service"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// DATABASE_URL → read AILog from Postgres (read-only). Otherwise fall back to
	// the in-memory seed so the service runs with zero external dependencies.
	var repo repository.UsageRepository
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		pool, err := repository.NewPool(context.Background(), dsn)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		defer pool.Close()
		repo = repository.NewPgxRepository(pool)
		log.Println("repository: Postgres (read-only AILog reader)")
	} else {
		repo = repository.NewMemoryRepository(repository.SeedRows(time.Now().UTC()))
		log.Println("repository: in-memory (seeded demo data)")
	}

	svc := service.New(repo, domain.DefaultPricing())
	router := httpapi.NewRouter(svc)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("usage-metrics-svc listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down…")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	log.Println("stopped")
}
