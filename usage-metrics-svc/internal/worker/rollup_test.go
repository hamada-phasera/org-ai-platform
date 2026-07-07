package worker

import (
	"context"
	"errors"
	"io"
	"log"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWriter signals each RefreshRollup call on a channel so tests can observe
// the worker's behavior deterministically, without sleeps.
type fakeWriter struct {
	calls atomic.Int64
	ch    chan string
	err   error
}

func (f *fakeWriter) RefreshRollup(_ context.Context, _ int) (int64, error) {
	f.calls.Add(1)
	f.ch <- "called"
	return 1, f.err
}

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

func TestWorkerRefreshesOnStartupAndTriggerThenStops(t *testing.T) {
	fw := &fakeWriter{ch: make(chan string, 8)}
	// Long interval so the ticker never fires during the test — we drive it
	// via startup + Trigger only.
	w := New(fw, time.Hour, 7, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()

	// 1) startup refresh
	select {
	case <-fw.ch:
	case <-time.After(2 * time.Second):
		t.Fatal("expected a startup refresh")
	}

	// 2) on-demand trigger
	w.Trigger()
	select {
	case <-fw.ch:
	case <-time.After(2 * time.Second):
		t.Fatal("expected a triggered refresh")
	}

	// 3) clean stop on context cancel
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not stop after context cancel")
	}

	if got := fw.calls.Load(); got < 2 {
		t.Fatalf("expected at least 2 refreshes (startup + trigger), got %d", got)
	}
}

func TestWorkerTriggerCoalesces(t *testing.T) {
	// The trigger channel has capacity 1, so many Trigger() calls before the
	// worker drains it collapse to a single pending refresh.
	fw := &fakeWriter{ch: make(chan string, 8)}
	w := New(fw, time.Hour, 7, quietLogger())

	for i := 0; i < 100; i++ {
		w.Trigger()
	}
	// At most one token is buffered.
	if len(w.trigger) > 1 {
		t.Fatalf("trigger channel buffered %d, want ≤ 1", len(w.trigger))
	}
}

func TestWorkerSurvivesRefreshError(t *testing.T) {
	fw := &fakeWriter{ch: make(chan string, 8), err: errors.New("boom")}
	w := New(fw, time.Hour, 7, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()

	// startup refresh errors but the worker keeps running and accepts a trigger
	select {
	case <-fw.ch:
	case <-time.After(2 * time.Second):
		t.Fatal("expected startup refresh")
	}
	w.Trigger()
	select {
	case <-fw.ch:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not survive a failed refresh")
	}
	cancel()
	<-done
}
