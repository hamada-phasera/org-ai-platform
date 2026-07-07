// Package service wires the repository to the aggregation logic and annotates
// the result with the requested tenant + window.
package service

import (
	"context"

	"github.com/hamada-phasera/usage-metrics-svc/internal/aggregate"
	"github.com/hamada-phasera/usage-metrics-svc/internal/domain"
	"github.com/hamada-phasera/usage-metrics-svc/internal/repository"
)

// Service is the application core: fetch rows (read-only) → aggregate → annotate.
type Service struct {
	repo    repository.UsageRepository
	pricing domain.Pricing
}

// New builds a Service from a repository and a pricing table.
func New(repo repository.UsageRepository, pricing domain.Pricing) *Service {
	return &Service{repo: repo, pricing: pricing}
}

// GetUsage returns the aggregated usage report for a tenant + window.
func (s *Service) GetUsage(ctx context.Context, p domain.QueryParams) (domain.UsageReport, error) {
	rows, err := s.repo.FetchUsageRows(ctx, p)
	if err != nil {
		return domain.UsageReport{}, err
	}
	report := aggregate.Aggregate(rows, s.pricing)
	report.TenantID = p.OrgID
	report.From = p.From
	report.To = p.To
	return report, nil
}

// GetDepartments returns per-department KPI rows (calls / tokens / cost /
// latency) for a tenant + window, for GET /metrics/departments.
func (s *Service) GetDepartments(ctx context.Context, p domain.QueryParams) (domain.DepartmentsReport, error) {
	rows, err := s.repo.FetchUsageRows(ctx, p)
	if err != nil {
		return domain.DepartmentsReport{}, err
	}
	depts, unknown := aggregate.AggregateDepartments(rows, s.pricing)
	return domain.DepartmentsReport{
		TenantID:      p.OrgID,
		From:          p.From,
		To:            p.To,
		Departments:   depts,
		UnknownModels: unknown,
	}, nil
}
