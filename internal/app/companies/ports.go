// The companies port: how a use-case stores company pages, and how a new page gets its slug.
// In the app: the company page, the companies table and compare view, every research agent's write.
// Used by: use-cases (Phases 3-4) and the seed import, through store.Tx.
//
// Like jobs, the repository stores the record the domain computed. A company is never deleted
// here: its page is what links its jobs, emails and reviews together.

package companies

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// Repository stores companies by slug. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Get returns the company at a slug, or storeerr.ErrNotFound.
	Get(ctx context.Context, slug string) (domain.Company, error)
	// List returns every company ordered by name (case-insensitive), ties by slug.
	List(ctx context.Context) ([]domain.Company, error)
	// Create stores a new company; storeerr.ErrExists when the slug is taken.
	Create(ctx context.Context, company domain.Company) error
	// Update replaces a stored company with the one the domain computed; storeerr.ErrNotFound when it is gone.
	Update(ctx context.Context, company domain.Company) error
}

// maxSlugAttempts bounds the search for a free slug, so a corrupted table can't loop forever.
const maxSlugAttempts = 10000

// AllocateSlug picks the slug a company called `name` lives at. A name that slugifies to nothing
// ("日本") falls back to company-<n>, the first free n. Otherwise the plain slug is used when it
// is free or already belongs to the same company (same name ignoring case and surrounding
// space: "Ramp" and "ramp " are one page); when a different company holds it, a numeric suffix
// is added (acme, acme-2, acme-3). existed is true when the slug is that same company's.
//
// Limit: a job's CompanySlug is derived by the domain from its company name alone, so a suffixed
// page is not reached from its jobs by name; the caller that creates it links them explicitly.
func AllocateSlug(ctx context.Context, repository Repository, name string) (slug string, existed bool, err error) {
	name = strings.TrimSpace(name)
	base := domain.Slugify(name)
	fallback := base == ""
	for attempt := 1; attempt <= maxSlugAttempts; attempt++ {
		candidate := candidateSlug(base, fallback, attempt)
		holder, err := repository.Get(ctx, candidate)
		switch {
		case errors.Is(err, storeerr.ErrNotFound):
			return candidate, false, nil
		case err != nil:
			return "", false, fmt.Errorf("look up company %s: %w", candidate, err)
		case !fallback && strings.EqualFold(strings.TrimSpace(holder.Name), name):
			return candidate, true, nil
		}
	}
	return "", false, fmt.Errorf("no free slug for %q after %d tries", name, maxSlugAttempts)
}

// candidateSlug is the attempt-th slug to try: base, base-2, base-3 …, or company-1, company-2 … for a nameless one.
func candidateSlug(base string, fallback bool, attempt int) string {
	if fallback {
		return fmt.Sprintf("company-%d", attempt)
	}
	if attempt == 1 {
		return base
	}
	suffix := fmt.Sprintf("-%d", attempt)
	if len(base)+len(suffix) > domain.MaxSlugLength {
		base = strings.TrimRight(base[:domain.MaxSlugLength-len(suffix)], "-")
	}
	return base + suffix
}
