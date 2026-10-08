// Salvage: keeps the valid part of a seeded record when one piece of it breaks a domain rule.
// In the app: an import of an older or hand-edited seed file (a review rated 4.1 out of 3, a contact with no name).
// Used by: importseed.go.
// Uses: internal/domain (the rules the pieces are held to).
//
// Without this a single bad review would cost the whole company page. Each dropped piece is
// named in the report, so the owner can add it back by hand.

package importseed

import (
	"strings"

	"github.com/bretperry/hussla/internal/domain"
)

// salvageCompanyPatch drops reviews and news items the domain would refuse, and says which.
func (i *importer) salvageCompanyPatch(where string, patch domain.CompanyPatch) domain.CompanyPatch {
	if patch.Reviews.IsSet() {
		var kept []domain.Review
		for _, review := range patch.Reviews.Value() {
			if err := review.Validate(); err != nil {
				i.warn(where, "dropped the review from %q: %v", review.Source, err)
				continue
			}
			kept = append(kept, review)
		}
		patch.Reviews = domain.Set(kept)
	}
	if patch.News.IsSet() {
		var kept []domain.NewsItem
		for _, item := range patch.News.Value() {
			if strings.TrimSpace(item.Headline) == "" {
				i.warn(where, "dropped a news item with no headline")
				continue
			}
			kept = append(kept, item)
		}
		patch.News = domain.Set(kept)
	}
	return patch
}

// salvageJobPatch drops contacts with no name and numbers outside their range, and says which.
func (i *importer) salvageJobPatch(where string, patch domain.JobPatch) domain.JobPatch {
	if patch.Contacts.IsSet() {
		var kept []domain.Contact
		for _, contact := range patch.Contacts.Value() {
			if err := contact.Validate(); err != nil {
				i.warn(where, "dropped a contact with no name")
				continue
			}
			kept = append(kept, contact)
		}
		patch.Contacts = domain.Set(kept)
	}
	if score := patch.Score.Value(); patch.Score.IsSet() && score != nil && (*score < domain.MinScore || *score > domain.MaxScore) {
		i.warn(where, "dropped a score outside 0-100")
		patch.Score = domain.Field[*int]{}
	}
	for name, field := range map[string]*domain.Field[*int]{"salaryMin": &patch.SalaryMin, "salaryMax": &patch.SalaryMax} {
		if value := field.Value(); field.IsSet() && value != nil && *value < 0 {
			i.warn(where, "dropped a negative %s", name)
			*field = domain.Field[*int]{}
		}
	}
	return patch
}
