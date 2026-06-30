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
