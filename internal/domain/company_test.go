// Tests for companies: the patch rule, news and review upserts, and the compare summary (best fit, pay, ratings, health, layoffs).

package domain_test

import (
	"errors"
	"reflect"
	"testing"

	"github.com/bretperry/hussla/internal/domain"
)

func floatPointer(value float64) *float64 { return &value }

func TestNewCompanySlugAndName(t *testing.T) {
	company, err := domain.NewCompany("  Example Labs, Inc. ", createdAt)
	if err != nil || company.Slug != "example-labs-inc" || company.Name != "Example Labs, Inc." {
		t.Fatalf("NewCompany = %+v, %v", company, err)
	}
	if _, err := domain.NewCompany("!!!", createdAt); err == nil {
		t.Fatal("a name with no letters: want an error")
	}
}

func TestApplyCompanyPatchReplacesTopLevelAndKeepsTheRest(t *testing.T) {
	company, _ := domain.NewCompany("Example Labs", createdAt)
	company.Profile = domain.Profile{Website: "https://example.com", HQ: "Somewhere"}
	company.Facts = []string{"Founded by two engineers"}
	company.Notes = "Owner's own note"
	next, err := domain.ApplyCompanyPatch(company, domain.CompanyPatch{
		Profile:   domain.Set(domain.Profile{Website: "https://example.org"}),
		QuickTake: domain.Set("A small, steady company."),
		Facts:     domain.Clear[[]string](),
	}, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if next.Profile.HQ != "" || next.Profile.Website != "https://example.org" {
		t.Errorf("profile = %+v; a named object replaces whole", next.Profile)
	}
	if next.Facts != nil || next.Notes != "Owner's own note" || next.Slug != company.Slug {
		t.Errorf("company = %+v", next)
	}
	if !next.UpdatedAt.Equal(patchedAt) {
		t.Errorf("updatedAt = %v", next.UpdatedAt)
	}
	renamed, err := domain.ApplyCompanyPatch(company, domain.CompanyPatch{Name: domain.Set("Example Labs Holdings")}, patchedAt)
	if err != nil || renamed.Slug != company.Slug {
		t.Errorf("renaming moved the slug to %q (%v); links must keep working", renamed.Slug, err)
	}
	if _, err := domain.ApplyCompanyPatch(company, domain.CompanyPatch{Name: domain.Clear[string]()}, patchedAt); err == nil {
		t.Error("clearing the name: want an error")
	}
}

func TestUpsertNewsDedupesByURLAndSortsNewestFirst(t *testing.T) {
	news := []domain.NewsItem{
		{Date: "2026-05", Headline: "Raised a round", URL: "https://news.example/a"},
		{Date: "2025-11-02", Headline: "Launched a product", URL: "https://news.example/b"},
	}
	updated, err := domain.UpsertNews(news, domain.NewsItem{Date: "2026-08-28", Headline: "Raised a bigger round", URL: "https://news.example/a"})
	if err != nil {
		t.Fatal(err)
	}
	headlines := []string{}
	for _, item := range updated {
		headlines = append(headlines, item.Headline)
	}
	if want := []string{"Raised a bigger round", "Launched a product"}; !reflect.DeepEqual(headlines, want) {
		t.Fatalf("headlines = %v, want %v", headlines, want)
	}
	if len(news) != 2 || news[0].Headline != "Raised a round" {
		t.Fatal("UpsertNews mutated its input")
	}
	if _, err := domain.UpsertNews(news, domain.NewsItem{Date: "2026"}); err == nil {
		t.Fatal("news with no headline: want an error")
	}
}

func TestUpsertReviewReplacesSameSource(t *testing.T) {
	reviews := []domain.Review{{Source: "Glassdoor", Rating: floatPointer(3.9)}, {Source: "Indeed", Rating: floatPointer(4.0)}}
	updated, err := domain.UpsertReview(reviews, domain.Review{Source: "glassdoor", Rating: floatPointer(4.2)}, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != 2 || *updated[0].Rating != 4.2 || !updated[0].FetchedAt.Equal(patchedAt) {
		t.Fatalf("updated = %+v", updated)
	}
	_, err = domain.UpsertReview(nil, domain.Review{Source: "Blind", Rating: floatPointer(7)}, patchedAt)
	var validationError *domain.ValidationError
	if !errors.As(err, &validationError) || validationError.Field != "rating" {
		t.Fatalf("rating 7 of 5: err = %v", err)
	}
}

func TestSummarizeCompany(t *testing.T) {
	company := domain.Company{
		Slug: "example-labs", Name: "Example Labs",
		Financials: domain.Financials{
			HealthSignal: domain.HealthSignalWatch, MarketCap: "$2B (Oct 2026)",
			Layoffs: []domain.Layoff{{Date: "2025-01"}, {Date: "2026-03"}},
		},
		Reviews: []domain.Review{
			{Source: "Glassdoor (predecessor)", Rating: floatPointer(3.8), ReviewCount: intPointer(120)},
			{Source: "Indeed", Rating: floatPointer(4.1)},
			{Source: "Blind", Rating: floatPointer(3.0)},
			{Source: "Company survey (self-published)", Rating: floatPointer(4.9)},
			{Source: "Tech press (news)", Rating: floatPointer(1.0)},
			{Source: "Some 10-point site", Rating: floatPointer(9.0), RatingScale: 10},
			{Source: "Levels.fyi"},
		},
	}
	jobs := []domain.Job{
		{ID: "a", CompanySlug: "example-labs", Score: intPointer(71), SalaryMin: intPointer(150000), SalaryMax: intPointer(190000)},
		{ID: "b", CompanySlug: "example-labs", Score: intPointer(88), SalaryMin: intPointer(0)},
		{ID: "c", CompanySlug: "example-labs"},
		{ID: "elsewhere", CompanySlug: "other-co", Score: intPointer(99), SalaryMax: intPointer(900000)},
	}
	summary := domain.SummarizeCompany(company, jobs)
	if len(summary.Jobs) != 3 {
		t.Errorf("jobs = %d, want 3 (other companies' jobs left out)", len(summary.Jobs))
	}
	if summary.BestScore == nil || *summary.BestScore != 88 {
		t.Errorf("bestScore = %v, want 88", summary.BestScore)
	}
	if *summary.PayMin != 150000 || *summary.PayMax != 190000 {
		t.Errorf("pay = %d-%d, want 150000-190000 (zero bounds ignored)", *summary.PayMin, *summary.PayMax)
	}
	if *summary.Glassdoor != 3.8 || *summary.GlassdoorCount != 120 {
		t.Errorf("glassdoor = %v (%v)", *summary.Glassdoor, *summary.GlassdoorCount)
	}
	// (3.8 + 4.1 + 3.0) / 3 = 3.633 → 3.6; survey, news and the 10-point site left out.
	if *summary.AvgRating != 3.6 {
		t.Errorf("avgRating = %v, want 3.6", *summary.AvgRating)
	}
	if summary.HealthRank != 2 || summary.LayoffCount != 2 || summary.Valuation != "$2B (Oct 2026)" {
		t.Errorf("health %d, layoffs %d, valuation %q", summary.HealthRank, summary.LayoffCount, summary.Valuation)
	}

	empty := domain.SummarizeCompany(domain.Company{Slug: "quiet-co"}, nil)
	if empty.BestScore != nil || empty.PayMax != nil || empty.AvgRating != nil || empty.Glassdoor != nil || empty.HealthRank != 0 {
		t.Errorf("a company with nothing known = %+v, want every number nil", empty)
	}
}

func TestHealthRankOrder(t *testing.T) {
	ordered := []domain.HealthSignal{domain.HealthSignalStrong, domain.HealthSignalSteady, domain.HealthSignalWatch, domain.HealthSignalRisky, domain.HealthSignalUnknown}
	for index := 1; index < len(ordered); index++ {
		if ordered[index-1].Rank() <= ordered[index].Rank() {
			t.Errorf("%v should rank above %v", ordered[index-1], ordered[index])
		}
	}
	for _, name := range domain.HealthSignalNames() {
		if signal, err := domain.ParseHealthSignal(name); err != nil || signal.String() != name {
			t.Errorf("%q round-trips to %v (%v)", name, signal, err)
		}
	}
}
