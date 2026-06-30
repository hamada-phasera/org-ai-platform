// Command server runs usage-metrics-svc.
//
// No DATABASE_URL  → in-memory seeded data (zero dependencies; demo/dev).
// With DATABASE_URL → reads AILog from Postgres AND starts the async rollup
//
//	worker. METRICS_SOURCE selects the read path:
//	  raw    (default) → read AILog directly (read-only tx)
//	  rollup           → read usage_daily_rollup (fast path)
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/httpapi"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
	"github.com/hamada-phasera/usage-metrics-svc/internal/service"
	"github.com/hamada-phasera/usage-metrics-svc/internal/worker"
)

func main() {
	port := getenv("PORT", "8080")
	pricing := domain.DefaultPricing()

	// Root context for background goroutines (the rollup worker); cancelled on
	// shutdown so the worker stops before the process exits.
	rootCtx, cancelRoot := context.WithCancel(context.Background())
	defer cancelRoot()

	var provider httpapi.UsageProvider
	var closeDB func()

	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		pool, err := repository.NewPool(context.Background(), dsn)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		closeDB = pool.Close

		// Async rollup worker — the only writer; writes only usage_daily_rollup.
		interval := getdur("ROLLUP_INTERVAL", 5*time.Minute)
		sinceDays := getint("ROLLUP_SINCE_DAYS", 35)
		w := worker.New(repository.NewRollupRepository(pool), interval, sinceDays, log.Default())
		go w.Run(rootCtx)
		log.Printf("rollup worker started (interval=%s, sinceDays=%d)", interval, sinceDays)

		switch os.Getenv("METRICS_SOURCE") {
		case "rollup":
			provider = service.NewRollup(repository.NewRollupRepository(pool), pricing)
			log.Println("repository: Postgres rollup read (usage_daily_rollup)")
		default:
			provider = service.New(repository.NewPgxRepository(pool), pricing)
			log.Println("repository: Postgres raw read (read-only AILog)")
		}
	} else {
		provider = service.New(repository.NewMemoryRepository(repository.SeedRows(time.Now().UTC())), pricing)
		log.Println("repository: in-memory (seeded demo data)")
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           httpapi.NewRouter(provider),
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
	cancelRoot() // stop the worker

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	if closeDB != nil {
		closeDB()
	}
	log.Println("stopped")
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getint(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getdur(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
