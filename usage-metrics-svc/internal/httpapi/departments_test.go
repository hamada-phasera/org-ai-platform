package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
	"github.com/hamada-phasera/usage-metrics-svc/internal/service"
)

func TestDepartmentsMissingTenantReturns400(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics/departments", nil)
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

func TestDepartmentsInvalidRangeReturns400(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics/departments?tenant_id=demo-org&from=2026-06-02&to=2026-06-01", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestDepartmentsMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/metrics/departments?tenant_id=demo-org", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestDepartmentsReturnsPerDepartmentKpis(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/metrics/departments?tenant_id=demo-org", nil)
	rec := httptest.NewRecorder()
	newTestServer().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var body struct {
		Success bool                     `json:"success"`
		Data    domain.DepartmentsReport `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Success {
		t.Fatalf("success = false, body: %s", rec.Body.String())
	}
	if body.Data.TenantID != "demo-org" {
		t.Errorf("tenantId = %q, want demo-org", body.Data.TenantID)
	}
	if len(body.Data.Departments) == 0 {
		t.Fatalf("departments empty; seed data should produce at least one department")
	}
	// Tenant isolation: seeded other-org rows must not leak into demo-org KPIs.
	totalCalls := 0
	for _, d := range body.Data.Departments {
		totalCalls += d.Calls
		if d.Calls <= 0 {
			t.Errorf("department %q has non-positive calls %d", d.Department, d.Calls)
		}
	}
	// Sorted by calls desc (then name asc) — verify ordering invariant.
	for i := 1; i < len(body.Data.Departments); i++ {
		prev, cur := body.Data.Departments[i-1], body.Data.Departments[i]
		if cur.Calls > prev.Calls {
			t.Errorf("departments not sorted by calls desc: %q(%d) before %q(%d)",
				prev.Department, prev.Calls, cur.Department, cur.Calls)
		}
	}
}

// TestDepartmentsNotRegisteredForUsageOnlyProvider pins the compatibility
// contract: a provider that lacks GetDepartments still routes /metrics/usage,
// while /metrics/departments returns 404.
func TestDepartmentsNotRegisteredForUsageOnlyProvider(t *testing.T) {
	repo := repository.NewMemoryRepository(repository.SeedRows(time.Now().UTC()))
	full := service.New(repo, domain.DefaultPricing())
	router := NewRouter(usageOnlyProvider{full})

	req := httptest.NewRequest(http.MethodGet, "/metrics/departments?tenant_id=demo-org", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for usage-only provider", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/metrics/usage?tenant_id=demo-org", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("usage status = %d, want 200", rec.Code)
	}
}

// usageOnlyProvider hides GetDepartments from the underlying service so the
// router sees a UsageProvider that does not implement DepartmentsProvider.
type usageOnlyProvider struct {
	inner UsageProvider
}

func (u usageOnlyProvider) GetUsage(ctx context.Context, p domain.QueryParams) (domain.UsageReport, error) {
	return u.inner.GetUsage(ctx, p)
}
