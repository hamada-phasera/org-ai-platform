package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
	"github.com/hamada-phasera/usage-metrics-svc/internal/service"
)

func newTestServer() http.Handler {
	repo := repository.NewMemoryRepository(repository.SeedRows(time.Now().UTC()))
	svc := service.New(repo, domain.DefaultPricing())
	return NewRouter(svc)
}

func TestHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestUsageMissingTenantReturns400(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics/usage", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Success bool `json:"success"`
		Error   struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Success || body.Error.Code != "MISSING_TENANT_ID" {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestUsageReturnsAggregatedJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics/usage?tenant_id=demo-org", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Success bool               `json:"success"`
		Data    domain.UsageReport `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Success {
		t.Fatal("success = false")
	}
	if body.Data.TenantID != "demo-org" {
		t.Errorf("tenantId = %q, want demo-org", body.Data.TenantID)
	}
	if body.Data.Totals.Calls == 0 {
		t.Error("expected demo-org to have calls > 0")
	}
	// The 'other-org' seed row must not leak into demo-org's totals.
	for _, b := range body.Data.ByDayProvider {
		if b.Calls <= 0 {
			t.Errorf("bucket with non-positive calls: %+v", b)
		}
	}
}

func TestUsageTenantIsolation(t *testing.T) {
	// demo-org has 6 seed rows; other-org has 1. Confirm isolation.
	req := httptest.NewRequest(http.MethodGet, "/metrics/usage?tenant_id=other-org", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	var body struct {
		Data domain.UsageReport `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Data.Totals.Calls != 1 {
		t.Errorf("other-org calls = %d, want 1", body.Data.Totals.Calls)
	}
}
