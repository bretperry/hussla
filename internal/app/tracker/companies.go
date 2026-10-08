// Company use-cases: the companies table, the company page, and research agents' writes (profile patch, one news item, one review).
// In the app: Companies, Compare, the company page; "Company profiles" in docs/agents-api.md.
// Used by: internal/httpapi company routes.

package tracker

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// ListCompanies returns one summary per company, by name.
func (s *Service) ListCompanies(ctx context.Context) ([]domain.CompanySummary, error) {
	var summaries []domain.CompanySummary
	err := s.store.View(ctx, func(tx store.Tx) error {
		companies, err := tx.Companies().List(ctx)
		if err != nil {
			return err
		}
		all, err := tx.Jobs().List(ctx, jobs.Filter{})
		if err != nil {
			return err
		}
		bySlug := map[string][]domain.Job{}
		for _, job := range all {
			bySlug[job.CompanySlug] = append(bySlug[job.CompanySlug], job)
		}
		for _, company := range companies {
			summaries = append(summaries, domain.SummarizeCompany(company, bySlug[company.Slug]))
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list companies: %w", err)
	}
	return summaries, nil
}

// CompanyDetail is the company page: the company, its summary, its jobs and its emails.
type CompanyDetail struct {
	Company domain.Company
	Summary domain.CompanySummary
	Jobs    []domain.Job
	Emails  []domain.Email
}

// GetCompany returns the company page, or storeerr.ErrNotFound.
func (s *Service) GetCompany(ctx context.Context, slug string) (CompanyDetail, error) {
	var detail CompanyDetail
	err := s.store.View(ctx, func(tx store.Tx) error {
		company, err := tx.Companies().Get(ctx, slug)
		if err != nil {
			return err
		}
		companyJobs, err := tx.Jobs().List(ctx, jobs.Filter{CompanySlug: slug})
		if err != nil {
			return err
		}
		list, err := tx.Emails().List(ctx, emails.Filter{CompanySlug: slug})
		if err != nil {
			return err
		}
		detail = CompanyDetail{Company: company, Summary: domain.SummarizeCompany(company, companyJobs), Jobs: companyJobs, Emails: list}
		return nil
	})
	if err != nil {
		return CompanyDetail{}, fmt.Errorf("get company %s: %w", slug, err)
	}
	return detail, nil
}

// PatchCompany changes the named fields, creating the page when the slug is new (it then needs a name).
func (s *Service) PatchCompany(ctx context.Context, actor Actor, slug string, patch domain.CompanyPatch) (domain.Company, error) {
	var company domain.Company
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, created, err := s.companyOrNew(ctx, tx, slug, patch.Name)
		if err != nil {
			return err
		}
		company, err = s.patchCompanyIn(ctx, tx, actor, current, created, patch)
		return err
	})
	if err != nil {
		return domain.Company{}, fmt.Errorf("patch company %s: %w", slug, err)
	}
	return company, nil
}

// companyOrNew reads the company at slug, or starts a new one named by the patch.
func (s *Service) companyOrNew(ctx context.Context, tx store.Tx, slug string, name domain.Field[string]) (domain.Company, bool, error) {
	current, err := tx.Companies().Get(ctx, slug)
	if err == nil {
		return current, false, nil
	}
	if !errors.Is(err, storeerr.ErrNotFound) {
		return domain.Company{}, false, err
	}
	if !domain.IsValidRecordID(slug) {
		return domain.Company{}, false, &domain.ValidationError{Field: "slug", Problem: "must be lowercase letters, digits and hyphens"}
	}
	if !name.IsSet() || strings.TrimSpace(name.Value()) == "" {
		return domain.Company{}, false, &domain.ValidationError{Field: "name", Problem: "is required for a new company"}
	}
	return domain.Company{Slug: slug, Name: strings.TrimSpace(name.Value()), UpdatedAt: domain.NormalizeTime(s.now())}, true, nil
}

func (s *Service) patchCompanyIn(ctx context.Context, tx store.Tx, actor Actor, current domain.Company, created bool, patch domain.CompanyPatch) (domain.Company, error) {
	now := s.now()
	result, err := domain.ApplyCompanyPatch(current, patch, actor.Writer, now)
	if err != nil {
		return domain.Company{}, err
	}
	if created {
		if err := tx.Companies().Create(ctx, result.Record); err != nil {
			return domain.Company{}, err
		}
		_, err := logEvent(ctx, tx, "", actor.Name, "Added company", result.Record.Name, now)
		return result.Record, err
	}
	if len(result.Changed) == 0 {
		return result.Record, nil
	}
	if err := tx.Companies().Update(ctx, result.Record); err != nil {
		return domain.Company{}, err
	}
	detail := changeDetail(actor.Writer, result.Changed, wire.CompanyObject(result.Before))
	_, err = logEvent(ctx, tx, "", actor.Name, "Updated company "+result.Record.Name, detail, now)
	return result.Record, err
}

// AddNews adds one news item to a company (same url replaces), kept newest first.
func (s *Service) AddNews(ctx context.Context, actor Actor, slug string, item domain.NewsItem) (domain.Company, error) {
	var company domain.Company
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Companies().Get(ctx, slug)
		if err != nil {
			return err
		}
		news, err := domain.UpsertNews(current.News, item)
		if err != nil {
			return err
		}
		company, err = s.patchCompanyIn(ctx, tx, actor, current, false, domain.CompanyPatch{News: domain.Set(news)})
		return err
	})
	if err != nil {
		return domain.Company{}, fmt.Errorf("add news to %s: %w", slug, err)
	}
	return company, nil
}

// SaveReview saves one review per source on a company; storeerr.ErrNotFound when there is no such company.
func (s *Service) SaveReview(ctx context.Context, actor Actor, slug string, review domain.Review) (domain.Company, error) {
	var company domain.Company
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Companies().Get(ctx, slug)
		if err != nil {
			return err
		}
		reviews, err := domain.UpsertReview(current.Reviews, review, s.now())
		if err != nil {
			return err
		}
		company, err = s.patchCompanyIn(ctx, tx, actor, current, false, domain.CompanyPatch{Reviews: domain.Set(reviews)})
		return err
	})
	if err != nil {
		return domain.Company{}, fmt.Errorf("save review on %s: %w", slug, err)
	}
	return company, nil
}
