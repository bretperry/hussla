// Company reviews: one rating and summary per source (Glassdoor, Blind, Indeed...), shared by all of a company's jobs.
// In the app: the company page's reviews block and the companies table's rating columns (via CompanySummary).
// Used by: company.go (Company.Reviews, the summary), the reviews use-case (POST /api/companies/:slug/reviews, Phase 3).

package domain

import (
	"strings"
	"time"
)

// DefaultRatingScale is the scale a review is on when the agent doesn't say: most sites rate out of 5.
const DefaultRatingScale = 5.0

// Review is what one source says about a company. Rating and ReviewCount are pointers because an
// agent records only numbers it saw ("never invent facts"): a source with no rating has none.
type Review struct {
	Source      string
	Rating      *float64
	RatingScale float64 // 0 means DefaultRatingScale
	ReviewCount *int
	Summary     string
	Pros        []string
	Cons        []string
	URL         string
	FetchedAt   time.Time
}

// Scale is the review's rating scale, with the default filled in.
func (review Review) Scale() float64 {
	if review.RatingScale == 0 {
		return DefaultRatingScale
	}
	return review.RatingScale
}

// Validate checks the review has a source and a rating that fits its scale.
func (review Review) Validate() error {
	if strings.TrimSpace(review.Source) == "" {
		return invalid("source", `is required (e.g. "Glassdoor")`)
	}
	if review.RatingScale < 0 {
		return invalid("ratingScale", "must be positive")
	}
	if review.Rating != nil && (*review.Rating < 0 || *review.Rating > review.Scale()) {
		return invalid("rating", "must be between 0 and the rating scale")
	}
	if review.ReviewCount != nil && *review.ReviewCount < 0 {
		return invalid("reviewCount", "can't be negative")
	}
	return nil
}

// UpsertReview saves one review into a company's list: it replaces the review from the same source
// (matched ignoring case) where it stands, or appends a new one. FetchedAt defaults to now.
// The input list is not mutated.
func UpsertReview(reviews []Review, review Review, now time.Time) ([]Review, error) {
	if err := review.Validate(); err != nil {
		return nil, err
	}
	review.Source = strings.TrimSpace(review.Source)
	if review.FetchedAt.IsZero() {
		review.FetchedAt = NormalizeTime(now)
	}
	updated := append([]Review(nil), reviews...)
	for index := range updated {
		if strings.EqualFold(strings.TrimSpace(updated[index].Source), review.Source) {
			updated[index] = review
			return updated, nil
		}
	}
	return append(updated, review), nil
}
