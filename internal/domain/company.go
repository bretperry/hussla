// Companies: the "get up to speed" profile behind every job (quick take, money, facts, news, reviews) and its summary for comparing.
// In the app: the company page, the companies table and the 2-4 company compare view; research agents fill it with PATCH.
// Used by: the companies use-cases and storage (Phases 2-3); the HTTP layer's GET /api/companies.
// Uses: slug.go (the slug a company lives at), review.go, job.go (for the summary).
//
// Patch rule: top-level fields merge, each named one replaces whole (so `profile` and
// `financials` are replaced as objects, the prototype's behavior), and null clears.

package domain

import (
	"cmp"
	"math"
	"slices"
	"strings"
	"time"
)

// HealthSignal is a research agent's one-word read on the company's financial health.
type HealthSignal int

const (
	HealthSignalUnknown HealthSignal = iota
	HealthSignalStrong
	HealthSignalSteady
	HealthSignalWatch
	HealthSignalRisky
)

var healthSignalNames = []string{"", "strong", "steady", "watch", "risky"}

func (signal HealthSignal) String() string { return enumName(healthSignalNames, signal) }

// ParseHealthSignal reads an API spelling; "" is HealthSignalUnknown.
func ParseHealthSignal(text string) (HealthSignal, error) {
	signal, ok := parseEnum[HealthSignal](healthSignalNames, text)
	if !ok {
		return HealthSignalUnknown, invalid("healthSignal", `must be "strong", "steady", "watch", "risky" or empty`)
	}
	return signal, nil
}

// HealthSignalNames lists every API spelling, for the contract.
func HealthSignalNames() []string { return append([]string(nil), healthSignalNames...) }

// Rank orders signals for sorting the compare table: higher is healthier, unknown sorts last.
func (signal HealthSignal) Rank() int {
	switch signal {
	case HealthSignalStrong:
		return 4
	case HealthSignalSteady:
		return 3
	case HealthSignalWatch:
		return 2
	case HealthSignalRisky:
		return 1
	case HealthSignalUnknown:
		return 0
	}
	return 0
}

// Profile is the company's basic facts. Phone is a company main line only, never a person's.
type Profile struct {
	Website      string
	CareersURL   string
	LinkedIn     string
	HQ           string
	Founded      *int
	Employees    string // with source and date: "about 900 (LinkedIn, Oct 2026)"
	CEO          string
	Type         string // "private", "public", "subsidiary"
	Ticker       string
	Stage        string
	Phone        string
	PhoneLabel   string
	RemotePolicy string
}

// FundingRound is one priced round. Amounts come as the text an agent read and, when it could, a number in US dollars.
type FundingRound struct {
	Type          string
	Amount        string
	AmountUSD     *int64
	Date          string // "2025-06" or "2025-06-12": as precise as the source
	LeadInvestors []string
}

// Layoff is one reported layoff.
type Layoff struct {
	Date   string
	Detail string
	URL    string
}

// Financials is the money picture: funding, valuation, revenue, layoffs and the health read.
// Every text field carries its source and date in the text; numbers are only what a source said.
type Financials struct {
	TotalFunding    string
	TotalFundingUSD *int64
	LastRound       *FundingRound
	Valuation       string
	ValuationUSD    *int64
	Revenue         string
	RevenueUSD      *int64
	Growth          string
	Profitability   string
	MarketCap       string
	StockNote       string
	Investors       []string
	Layoffs         []Layoff
	HealthSignal    HealthSignal
	HealthNote      string
}

// Anecdote is one story about working there, with where it came from.
type Anecdote struct {
	Text   string
	Source string
	URL    string
}

// NewsItem is one dated headline. Date is as precise as the source ("2026", "2026-08", "2026-08-28").
type NewsItem struct {
	Date     string
	Headline string
	Summary  string
	Source   string
	URL      string
}

// Company is one employer and everything researched about it, keyed by slug.
type Company struct {
	Slug      string
	Name      string
	UpdatedAt time.Time

	QuickTake        string
	Profile          Profile
	Financials       Financials
	Facts            []string
	Anecdotes        []Anecdote
	News             []NewsItem
	Reviews          []Review
	Interview        string // what the interview process is like, markdown
	Sources          []string
	Notes            string // Bret's own; agents don't overwrite (enforced in the HTTP layer)
	ProfileFetchedAt time.Time
	ReviewsFetchedAt time.Time

	Extras  Extras
	Writers FieldWriters // who last wrote each field; see writer.go
}

// CompanyPatch names the company fields one write speaks for. The zero CompanyPatch changes nothing.
type CompanyPatch struct {
	Name             Field[string]
	QuickTake        Field[string]
	Profile          Field[Profile]
	Financials       Field[Financials]
	Facts            Field[[]string]
	Anecdotes        Field[[]Anecdote]
	News             Field[[]NewsItem]
	Reviews          Field[[]Review]
	Interview        Field[string]
	Sources          Field[[]string]
	Notes            Field[string]
	ProfileFetchedAt Field[time.Time]
	ReviewsFetchedAt Field[time.Time]

	Extras ExtrasPatch
}

// companyFieldNames is every company key the API knows by name (read-only ones included), so none can be an extra.
var companyFieldNames = map[string]bool{
	"slug": true, "name": true, "updatedAt": true, "writers": true, "quickTake": true, "profile": true,
	"financials": true, "facts": true, "anecdotes": true, "news": true, "reviews": true,
	"interview": true, "sources": true, "notes": true, "profileFetchedAt": true, "reviewsFetchedAt": true,
}

// IsCompanyFieldName reports whether a JSON key is one of the company's named fields (so not an extra).
func IsCompanyFieldName(key string) bool { return companyFieldNames[key] }

// NewCompany starts a company page from a display name; the slug comes from the name.
func NewCompany(name string, now time.Time) (Company, error) {
	name = strings.TrimSpace(name)
	slug := Slugify(name)
	if slug == "" {
		return Company{}, invalid("name", "needs at least one letter or digit")
	}
	return Company{Slug: slug, Name: name, UpdatedAt: NormalizeTime(now)}, nil
}

// ApplyCompanyPatch writes `writer`'s patch onto a stored company. An agent patch that would change
// a field the owner last wrote is refused whole (OwnerFieldsError). The slug never changes, even
// when the name does, so links and jobs keep pointing at the same page.
func ApplyCompanyPatch(current Company, patch CompanyPatch, writer Writer, now time.Time) (PatchResult[Company], error) {
	fail := func(err error) (PatchResult[Company], error) { return PatchResult[Company]{}, err }
	if patch.Name.IsCleared() || (patch.Name.IsSet() && strings.TrimSpace(patch.Name.Value()) == "") {
		return fail(invalid("name", "can't be empty"))
	}
	if patch.Reviews.IsSet() {
		for _, review := range patch.Reviews.Value() {
			if err := review.Validate(); err != nil {
				return fail(invalid("reviews", err.Error()))
			}
		}
	}
	if patch.News.IsSet() {
		for _, item := range patch.News.Value() {
			if strings.TrimSpace(item.Headline) == "" {
				return fail(invalid("news", "every item needs a headline"))
			}
		}
	}
	if err := validateExtrasPatch(current.Extras, patch.Extras, companyFieldNames); err != nil {
		return fail(err)
	}
	next := current
	next.Name = trimmed(patch.Name).Apply(current.Name)
	next.QuickTake = patch.QuickTake.Apply(current.QuickTake)
	next.Profile = patch.Profile.Apply(current.Profile)
	next.Financials = patch.Financials.Apply(current.Financials)
	next.Facts = slices.Clone(patch.Facts.Apply(current.Facts))
	next.Anecdotes = slices.Clone(patch.Anecdotes.Apply(current.Anecdotes))
	next.News = slices.Clone(patch.News.Apply(current.News))
	next.Reviews = slices.Clone(patch.Reviews.Apply(current.Reviews))
	next.Interview = patch.Interview.Apply(current.Interview)
	next.Sources = slices.Clone(patch.Sources.Apply(current.Sources))
	next.Notes = patch.Notes.Apply(current.Notes)
	next.ProfileFetchedAt = patch.ProfileFetchedAt.Apply(current.ProfileFetchedAt)
	next.ReviewsFetchedAt = patch.ReviewsFetchedAt.Apply(current.ReviewsFetchedAt)
	next.Extras = applyExtras(current.Extras, patch.Extras)
	changed := append(changedFields(companyFieldTable, current, next), changedExtras(current.Extras, next.Extras)...)
	writers, changed, err := settleWriters(current.Writers, changed, writer)
	if err != nil {
		return fail(err)
	}
	next.Writers = writers
	if len(changed) > 0 {
		next.UpdatedAt = NormalizeTime(now)
	}
	return PatchResult[Company]{Record: next, Before: current, Changed: changed}, nil
}

// companyFieldTable compares each patchable company field by its API name.
var companyFieldTable = []fieldComparison[Company]{
	{"name", func(a, b Company) bool { return a.Name == b.Name }},
	{"quickTake", func(a, b Company) bool { return a.QuickTake == b.QuickTake }},
	{"profile", func(a, b Company) bool { return sameProfile(a.Profile, b.Profile) }},
	{"financials", func(a, b Company) bool { return sameFinancials(a.Financials, b.Financials) }},
	{"facts", func(a, b Company) bool { return sameList(a.Facts, b.Facts) }},
	{"anecdotes", func(a, b Company) bool { return sameList(a.Anecdotes, b.Anecdotes) }},
	{"news", func(a, b Company) bool { return sameList(a.News, b.News) }},
	{"reviews", func(a, b Company) bool { return sameListFunc(a.Reviews, b.Reviews, sameReview) }},
	{"interview", func(a, b Company) bool { return a.Interview == b.Interview }},
	{"sources", func(a, b Company) bool { return sameList(a.Sources, b.Sources) }},
	{"notes", func(a, b Company) bool { return a.Notes == b.Notes }},
	{"profileFetchedAt", func(a, b Company) bool { return a.ProfileFetchedAt.Equal(b.ProfileFetchedAt) }},
	{"reviewsFetchedAt", func(a, b Company) bool { return a.ReviewsFetchedAt.Equal(b.ReviewsFetchedAt) }},
}

func sameProfile(a, b Profile) bool {
	founded := sameIntPointer(a.Founded, b.Founded)
	a.Founded, b.Founded = nil, nil
	return founded && a == b
}

func sameFinancials(a, b Financials) bool {
	return a.TotalFunding == b.TotalFunding && sameInt64Pointer(a.TotalFundingUSD, b.TotalFundingUSD) &&
		sameFundingRound(a.LastRound, b.LastRound) &&
		a.Valuation == b.Valuation && sameInt64Pointer(a.ValuationUSD, b.ValuationUSD) &&
		a.Revenue == b.Revenue && sameInt64Pointer(a.RevenueUSD, b.RevenueUSD) &&
		a.Growth == b.Growth && a.Profitability == b.Profitability && a.MarketCap == b.MarketCap &&
		a.StockNote == b.StockNote && sameList(a.Investors, b.Investors) && sameList(a.Layoffs, b.Layoffs) &&
		a.HealthSignal == b.HealthSignal && a.HealthNote == b.HealthNote
}

func sameFundingRound(a, b *FundingRound) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Type == b.Type && a.Amount == b.Amount && sameInt64Pointer(a.AmountUSD, b.AmountUSD) &&
		a.Date == b.Date && sameList(a.LeadInvestors, b.LeadInvestors)
}

func sameReview(a, b Review) bool {
	return a.Source == b.Source && sameFloatPointer(a.Rating, b.Rating) && a.RatingScale == b.RatingScale &&
		sameIntPointer(a.ReviewCount, b.ReviewCount) && a.Summary == b.Summary && sameList(a.Pros, b.Pros) &&
		sameList(a.Cons, b.Cons) && a.URL == b.URL && a.FetchedAt.Equal(b.FetchedAt)
}

// UpsertNews adds one headline without resending the list: an item with the same URL is replaced,
// and the list comes back newest first (by Date text, which sorts because it is year-first).
// The input list is not mutated.
func UpsertNews(news []NewsItem, item NewsItem) ([]NewsItem, error) {
	if strings.TrimSpace(item.Headline) == "" {
		return nil, invalid("headline", "is required")
	}
	updated := make([]NewsItem, 0, len(news)+1)
	for _, existing := range news {
		if item.URL != "" && existing.URL == item.URL {
			continue
		}
		updated = append(updated, existing)
	}
	updated = append(updated, item)
	slices.SortStableFunc(updated, func(left, right NewsItem) int { return cmp.Compare(right.Date, left.Date) })
	return updated, nil
}

// reviewSourcesLeftOutOfAverage are words that mark a "review" that isn't employees rating the
// company (a news story, the company's own survey); the average rating leaves those out.
var reviewSourcesLeftOutOfAverage = []string{"news", "self", "survey"}

// JobBrief is the slice of a job the companies table shows next to its company.
type JobBrief struct {
	ID        string
	Title     string
	Status    JobStatus
	Score     *int
	PayText   string
	SalaryMin *int
	SalaryMax *int
}

// CompanySummary is one row of the companies table and one column of the compare view.
type CompanySummary struct {
	Slug            string
	Name            string
	QuickTake       string
	Jobs            []JobBrief
	BestScore       *int     // highest fit score among its jobs; nil when none is scored
	PayMin          *int     // lowest positive salary bound among its jobs
	PayMax          *int     // highest positive salary bound among its jobs
	Glassdoor       *float64 // the Glassdoor rating, when there is one
	GlassdoorCount  *int
	AvgRating       *float64 // mean of 5-point employee-review ratings, one decimal
	HealthSignal    HealthSignal
	HealthRank      int
	HealthNote      string
	TotalFunding    string
	TotalFundingUSD *int64
	Valuation       string // valuation, or market cap for a public company
	ValuationUSD    *int64
	Revenue         string
	Employees       string
	HQ              string
	Founded         *int
	Stage           string
	RemotePolicy    string
	Phone           string
	LayoffCount     int
	NewsCount       int
	UpdatedAt       time.Time
}

// SummarizeCompany builds the compare row from a company and its jobs (jobs of other companies are ignored).
func SummarizeCompany(company Company, jobs []Job) CompanySummary {
	financials := company.Financials
	profile := company.Profile
	summary := CompanySummary{
		Slug: company.Slug, Name: company.Name, QuickTake: company.QuickTake,
		HealthSignal: financials.HealthSignal, HealthRank: financials.HealthSignal.Rank(), HealthNote: financials.HealthNote,
		TotalFunding: financials.TotalFunding, TotalFundingUSD: financials.TotalFundingUSD,
		Valuation: cmp.Or(financials.Valuation, financials.MarketCap), ValuationUSD: financials.ValuationUSD,
		Revenue: financials.Revenue, Employees: profile.Employees, HQ: profile.HQ, Founded: profile.Founded,
		Stage: profile.Stage, RemotePolicy: profile.RemotePolicy, Phone: profile.Phone,
		LayoffCount: len(financials.Layoffs), NewsCount: len(company.News), UpdatedAt: company.UpdatedAt,
	}
	for _, job := range jobs {
		if job.CompanySlug != company.Slug {
			continue
		}
		summary.Jobs = append(summary.Jobs, JobBrief{
			ID: job.ID, Title: job.Title, Status: job.Status, Score: job.Score,
			PayText: job.PayText, SalaryMin: job.SalaryMin, SalaryMax: job.SalaryMax,
		})
		if job.Score != nil && (summary.BestScore == nil || *job.Score > *summary.BestScore) {
			summary.BestScore = copyInt(job.Score)
		}
		for _, bound := range []*int{job.SalaryMin, job.SalaryMax} {
			if bound == nil || *bound <= 0 {
				continue
			}
			if summary.PayMin == nil || *bound < *summary.PayMin {
				summary.PayMin = copyInt(bound)
			}
			if summary.PayMax == nil || *bound > *summary.PayMax {
				summary.PayMax = copyInt(bound)
			}
		}
	}
	summary.Glassdoor, summary.GlassdoorCount = glassdoorRating(company.Reviews)
	summary.AvgRating = averageEmployeeRating(company.Reviews)
	return summary
}

// glassdoorRating is the first Glassdoor review that has a rating (its source may say "Glassdoor (predecessor)").
func glassdoorRating(reviews []Review) (*float64, *int) {
	for _, review := range reviews {
		if review.Rating != nil && strings.Contains(strings.ToLower(review.Source), "glassdoor") {
			rating := *review.Rating
			return &rating, copyInt(review.ReviewCount)
		}
	}
	return nil, nil
}

// averageEmployeeRating is the mean of ratings on a 5-point scale from employee-review sources,
// rounded to one decimal; nil when there are none. Other scales aren't converted: a 10-point
// survey and a 5-point site don't measure the same thing.
func averageEmployeeRating(reviews []Review) *float64 {
	total, count := 0.0, 0
	for _, review := range reviews {
		if review.Rating == nil || review.Scale() != DefaultRatingScale || isNonEmployeeSource(review.Source) {
			continue
		}
		total += *review.Rating
		count++
	}
	if count == 0 {
		return nil
	}
	average := math.Round(total/float64(count)*10) / 10
	return &average
}

func isNonEmployeeSource(source string) bool {
	lowered := strings.ToLower(source)
	for _, word := range reviewSourcesLeftOutOfAverage {
		if strings.Contains(lowered, word) {
			return true
		}
	}
	return false
}
