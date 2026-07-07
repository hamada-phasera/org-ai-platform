// Package httpapi exposes the HTTP surface for usage-metrics-svc.
//
// Endpoints:
//
//	GET /metrics/usage?tenant_id=<org>&from=<ts>&to=<ts>        aggregated KPIs
//	GET /metrics/departments?tenant_id=<org>&from=<ts>&to=<ts>  per-department KPIs
//	GET /healthz                                                liveness for App Runner/ECS
//
// The external contract uses "tenant_id"; internally that maps to AILog.orgId.
// Responses follow the org-ai-platform envelope:
//
//	success: { "success": true,  "data": {...} }
//	error:   { "success": false, "error": { "code": "...", "message": "..." } }
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
)

const (
	defaultWindow  = 30 * 24 * time.Hour
	requestTimeout = 5 * time.Second
)

// UsageProvider produces a usage report for a tenant + window. Both
// service.Service (raw AILog read) and service.RollupService (rollup read)
// satisfy it, so the HTTP layer is agnostic to the data source.
type UsageProvider interface {
	GetUsage(ctx context.Context, p domain.QueryParams) (domain.UsageReport, error)
}

// DepartmentsProvider produces per-department KPI rows for a tenant + window.
// Kept separate from UsageProvider so existing fakes/providers that only serve
// /metrics/usage keep compiling; both service.Service and service.RollupService
// implement it.
type DepartmentsProvider interface {
	GetDepartments(ctx context.Context, p domain.QueryParams) (domain.DepartmentsReport, error)
}

// Handler holds the dependencies for the HTTP layer. `now` is injectable for tests.
type Handler struct {
	provider UsageProvider
	now      func() time.Time
}

// NewRouter returns the configured HTTP handler. /metrics/departments is
// registered only when the provider also implements DepartmentsProvider
// (true for both built-in services).
func NewRouter(provider UsageProvider) http.Handler {
	h := &Handler{provider: provider, now: time.Now}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", h.health)
	mux.HandleFunc("/metrics/usage", h.usage)
	if dp, ok := provider.(DepartmentsProvider); ok {
		mux.HandleFunc("/metrics/departments", h.departments(dp))
	}
	return mux
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]string{"status": "ok"},
	})
}

func (h *Handler) usage(w http.ResponseWriter, r *http.Request) {
	params, ok := h.queryParams(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()

	report, err := h.provider.GetUsage(ctx, params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "AGGREGATION_FAILED", "failed to compute usage metrics")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": report})
}

// departments serves GET /metrics/departments — the per-department KPI view
// (calls / tokens / cost / latency), added for the analytics dashboard (A-3).
func (h *Handler) departments(provider DepartmentsProvider) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		params, ok := h.queryParams(w, r)
		if !ok {
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()

		report, err := provider.GetDepartments(ctx, params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "AGGREGATION_FAILED", "failed to compute department metrics")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": report})
	}
}

// queryParams validates method + tenant_id/from/to for the /metrics/* endpoints.
// On failure it writes the error response and returns ok=false.
func (h *Handler) queryParams(w http.ResponseWriter, r *http.Request) (domain.QueryParams, bool) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "only GET is supported")
		return domain.QueryParams{}, false
	}

	q := r.URL.Query()
	tenant := q.Get("tenant_id")
	if tenant == "" {
		writeError(w, http.StatusBadRequest, "MISSING_TENANT_ID", "tenant_id query parameter is required")
		return domain.QueryParams{}, false
	}

	to := h.now().UTC()
	from := to.Add(-defaultWindow)
	if v := q.Get("from"); v != "" {
		t, err := parseTime(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_FROM", "from must be RFC3339 or YYYY-MM-DD")
			return domain.QueryParams{}, false
		}
		from = t
	}
	if v := q.Get("to"); v != "" {
		t, err := parseTime(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_TO", "to must be RFC3339 or YYYY-MM-DD")
			return domain.QueryParams{}, false
		}
		to = t
	}
	if !to.After(from) {
		writeError(w, http.StatusBadRequest, "INVALID_RANGE", "to must be after from")
		return domain.QueryParams{}, false
	}

	return domain.QueryParams{OrgID: tenant, From: from, To: to}, true
}

// parseTime accepts RFC3339 timestamps or bare YYYY-MM-DD dates (UTC).
func parseTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"success": false,
		"error":   map[string]string{"code": code, "message": message},
	})
}
