package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

func TestCORSSetsHeaders(t *testing.T) {
	h := CORS("*")(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/metrics/usage", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Errorf("expected wrapped handler to run; got %d %q", rec.Code, rec.Body.String())
	}
}

func TestCORSPreflightShortCircuits(t *testing.T) {
	called := false
	h := CORS("https://example.com")(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodOptions, "/metrics/usage", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", rec.Code)
	}
	if called {
		t.Error("preflight OPTIONS should not reach the wrapped handler")
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://example.com" {
		t.Errorf("allow-origin = %q, want https://example.com", got)
	}
}
