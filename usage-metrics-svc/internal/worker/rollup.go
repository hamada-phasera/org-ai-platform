// Package worker maintains the usage_daily_rollup table asynchronously.
//
// The Worker runs in its own goroutine: it refreshes the rollup once on startup,
// then on a ticker, and also on demand via a coalescing trigger channel. Each
// refresh is an idempotent upsert (see repository.RefreshRollup), so overlapping
// or repeated runs converge rather than duplicate. It stops cleanly when its
// context is cancelled.
package worker

import (
	"context"
	"log"
	"time"
)

// RollupWriter performs one idempotent rollup refresh over the last sinceDays
// and reports how many grain rows were upserted. Implemented by
// repository.RollupRepository.
type RollupWriter interface {
	RefreshRollup(ctx context.Context, sinceDays int) (int64, error)
}

// Worker drives periodic rollup refreshes.
type Worker struct {
	writer    RollupWriter
	interval  time.Duration
	sinceDays int
	logger    *log.Logger
	trigger   chan struct{}
}

// New builds a Worker. interval is the periodic refresh cadence; sinceDays bounds
// each refresh to recent data so the worker stays cheap as AILog grows.
func New(writer RollupWriter, interval time.Duration, sinceDays int, logger *log.Logger) *Worker {
	if logger == nil {
		logger = log.Default()
	}
	return &Worker{
		writer:    writer,
		interval:  interval,
		sinceDays: sinceDays,
		logger:    logger,
		trigger:   make(chan struct{}, 1), // size 1 ⇒ pending triggers coalesce
	}
}

// Trigger requests an out-of-band refresh. Non-blocking: if a refresh is already
// pending, the extra trigger is dropped (the pending one covers it).
func (w *Worker) Trigger() {
	select {
	case w.trigger <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is cancelled, refreshing the rollup on startup, on each
// tick, and on each trigger. Intended to be launched as `go worker.Run(ctx)`.
func (w *Worker) Run(ctx context.Context) {
	w.refresh(ctx, "startup")

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logger.Printf("rollup worker: stopped (%v)", ctx.Err())
			return
		case <-ticker.C:
			w.refresh(ctx, "tick")
		case <-w.trigger:
			w.refresh(ctx, "trigger")
		}
	}
}

func (w *Worker) refresh(ctx context.Context, reason string) {
	start := time.Now()
	n, err := w.writer.RefreshRollup(ctx, w.sinceDays)
	if err != nil {
		// Best-effort: a failed refresh is logged, not fatal — the next tick
		// retries, and the raw read path is unaffected.
		w.logger.Printf("rollup worker: refresh failed (%s): %v", reason, err)
		return
	}
	w.logger.Printf("rollup worker: refreshed %d rows (%s, %s)", n, reason, time.Since(start).Round(time.Millisecond))
}
