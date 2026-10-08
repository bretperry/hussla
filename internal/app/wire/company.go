// Companies as JSON: the API-named object for a company page, and the patch an object makes.
// In the app: GET/PATCH /api/companies/:slug, the backup bundle's companies, and every stored company row's `data` cell.
// Used by: the SQLite adapter, the seed import, the HTTP layer (Phase 3).
// Uses: decode.go (the three-state field readers), nested.go (shared time reading).

package wire

import (
	"encoding/json"
	"errors"

	"github.com/bretperry/hussla/internal/domain"
)

type profileJSON struct {
	Website      string `json:"website"`
	CareersURL   string `json:"careersUrl"`
	LinkedIn     string `json:"linkedin"`
	HQ           string `json:"hq"`
	Founded      *int   `json:"founded"`
	Employees    string `json:"employees"`
	CEO          string `json:"ceo"`
	Type         string `json:"type"`
	Ticker       string `json:"ticker"`
	Stage        string `json:"stage"`
	Phone        string `json:"phone"`
	PhoneLabel   string `json:"phoneLabel"`
	RemotePolicy string `json:"remotePolicy"`
}

type fundingRoundJSON struct {
	Type          string   `json:"type"`
	Amount        string   `json:"amount"`
	AmountUSD     *int64   `json:"amountUsd"`
	Date          string   `json:"date"`
	LeadInvestors []string `json:"leadInvestors"`
}

type layoffJSON struct {
	Date   string `json:"date"`
	Detail string `json:"detail"`
	URL    string `json:"url"`
}

type financialsJSON struct {
	TotalFunding    string            `json:"totalFunding"`
	TotalFundingUSD *int64            `json:"totalFundingUsd"`
	LastRound       *fundingRoundJSON `json:"lastRound"`
	Valuation       string            `json:"valuation"`
	ValuationUSD    *int64            `json:"valuationUsd"`
	Revenue         string            `json:"revenue"`
	RevenueUSD      *int64            `json:"revenueUsd"`
	Growth          string            `json:"growth"`
	Profitability   string            `json:"profitability"`
	MarketCap       string            `json:"marketCap"`
	StockNote       string            `json:"stockNote"`
	Investors       []string          `json:"investors"`
	Layoffs         []layoffJSON      `json:"layoffs"`
	HealthSignal    string            `json:"healthSignal"`
	HealthNote      string            `json:"healthNote"`
}

type anecdoteJSON struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	URL    string `json:"url"`
}

type newsJSON struct {
	Date     string `json:"date"`
	Headline string `json:"headline"`
	Summary  string `json:"summary"`
	Source   string `json:"source"`
	URL      string `json:"url"`
}

type reviewJSON struct {
	Source      string   `json:"source"`
	Rating      *float64 `json:"rating"`
	RatingScale float64  `json:"ratingScale"`
	ReviewCount *int     `json:"reviewCount"`
	Summary     string   `json:"summary"`
	Pros        []string `json:"pros"`
	Cons        []string `json:"cons"`
	URL         string   `json:"url"`
	FetchedAt   *string  `json:"fetchedAt"`
}

// CompanyObject is a company as the API sends it: every named field, extras beside them (writers excluded, as for jobs).
func CompanyObject(company domain.Company) Object {
	object := marshalAll(map[string]any{
		"slug": company.Slug, "name": company.Name, "updatedAt": momentText(company.UpdatedAt),
		"quickTake": company.QuickTake, "profile": profileToJSON(company.Profile),
		"financials": financialsToJSON(company.Financials), "facts": listOrNull(company.Facts),
		"anecdotes": listOrNull(anecdotesToJSON(company.Anecdotes)), "news": listOrNull(newsToJSON(company.News)),
		"reviews": listOrNull(reviewsToJSON(company.Reviews)), "interview": company.Interview,
		"sources": listOrNull(company.Sources), "notes": company.Notes,
		"profileFetchedAt": momentText(company.ProfileFetchedAt), "reviewsFetchedAt": momentText(company.ReviewsFetchedAt),
	})
	addExtras(object, company.Extras)
	return object
}

func profileToJSON(profile domain.Profile) profileJSON {
	return profileJSON{
		Website: profile.Website, CareersURL: profile.CareersURL, LinkedIn: profile.LinkedIn, HQ: profile.HQ,
		Founded: profile.Founded, Employees: profile.Employees, CEO: profile.CEO, Type: profile.Type,
		Ticker: profile.Ticker, Stage: profile.Stage, Phone: profile.Phone, PhoneLabel: profile.PhoneLabel,
		RemotePolicy: profile.RemotePolicy,
	}
}

func financialsToJSON(financials domain.Financials) financialsJSON {
	encoded := financialsJSON{
		TotalFunding: financials.TotalFunding, TotalFundingUSD: financials.TotalFundingUSD,
		Valuation: financials.Valuation, ValuationUSD: financials.ValuationUSD,
		Revenue: financials.Revenue, RevenueUSD: financials.RevenueUSD, Growth: financials.Growth,
		Profitability: financials.Profitability, MarketCap: financials.MarketCap, StockNote: financials.StockNote,
		Investors: financials.Investors, HealthSignal: financials.HealthSignal.String(), HealthNote: financials.HealthNote,
	}
	if round := financials.LastRound; round != nil {
		encoded.LastRound = &fundingRoundJSON{
			Type: round.Type, Amount: round.Amount, AmountUSD: round.AmountUSD, Date: round.Date, LeadInvestors: round.LeadInvestors,
		}
	}
	if financials.Layoffs != nil {
		encoded.Layoffs = make([]layoffJSON, len(financials.Layoffs))
		for index, layoff := range financials.Layoffs {
			encoded.Layoffs[index] = layoffJSON{Date: layoff.Date, Detail: layoff.Detail, URL: layoff.URL}
		}
	}
	return encoded
}

func anecdotesToJSON(anecdotes []domain.Anecdote) []anecdoteJSON {
	if anecdotes == nil {
		return nil
	}
	encoded := make([]anecdoteJSON, len(anecdotes))
	for index, anecdote := range anecdotes {
		encoded[index] = anecdoteJSON{Text: anecdote.Text, Source: anecdote.Source, URL: anecdote.URL}
	}
	return encoded
}

func newsToJSON(news []domain.NewsItem) []newsJSON {
	if news == nil {
		return nil
	}
	encoded := make([]newsJSON, len(news))
	for index, item := range news {
		encoded[index] = newsJSON{Date: item.Date, Headline: item.Headline, Summary: item.Summary, Source: item.Source, URL: item.URL}
	}
	return encoded
}

func reviewsToJSON(reviews []domain.Review) []reviewJSON {
	if reviews == nil {
		return nil
	}
	encoded := make([]reviewJSON, len(reviews))
	for index, review := range reviews {
		encoded[index] = reviewJSON{
			Source: review.Source, Rating: review.Rating, RatingScale: review.RatingScale, ReviewCount: review.ReviewCount,
			Summary: review.Summary, Pros: review.Pros, Cons: review.Cons, URL: review.URL, FetchedAt: momentText(review.FetchedAt),
		}
	}
	return encoded
}

// DecodeCompanyPatch reads a company write. Read-only keys (slug, updatedAt, writers) are not part
// of the patch; any other unknown key becomes an extra.
func (decoder *Decoder) DecodeCompanyPatch(object Object) (domain.CompanyPatch, error) {
	var patch domain.CompanyPatch
	var errs [13]error
	patch.Name, errs[0] = textField(decoder, object, "name")
	patch.QuickTake, errs[1] = textField(decoder, object, "quickTake")
	patch.Profile, errs[2] = decodeField(decoder, object, "profile", parseProfile)
	patch.Financials, errs[3] = decodeField(decoder, object, "financials", parseFinancials)
	patch.Facts, errs[4] = textsField(decoder, object, "facts")
	patch.Anecdotes, errs[5] = decodeField(decoder, object, "anecdotes", parseAnecdotes)
	patch.News, errs[6] = decodeField(decoder, object, "news", parseNews)
	patch.Reviews, errs[7] = decodeField(decoder, object, "reviews", parseReviews)
	patch.Interview, errs[8] = textField(decoder, object, "interview")
	patch.Sources, errs[9] = textsField(decoder, object, "sources")
	patch.Notes, errs[10] = textField(decoder, object, "notes")
	patch.ProfileFetchedAt, errs[11] = momentField(decoder, object, "profileFetchedAt")
	patch.ReviewsFetchedAt, errs[12] = momentField(decoder, object, "reviewsFetchedAt")
	patch.Extras = extrasPatch(object, domain.IsCompanyFieldName)
	if err := firstError(errs[:]...); err != nil {
		return domain.CompanyPatch{}, err
	}
	return patch, nil
}

// DecodeCompany reads a stored company leniently, like DecodeJob. Writers are the caller's to set.
func DecodeCompany(object Object) (domain.Company, []string) {
	decoder := &Decoder{Lenient: true}
	patch, _ := decoder.DecodeCompanyPatch(object) // lenient: never fails
	company := domain.Company{
		Name: patch.Name.Apply(""), QuickTake: patch.QuickTake.Apply(""), Profile: patch.Profile.Apply(domain.Profile{}),
		Financials: patch.Financials.Apply(domain.Financials{}), Facts: patch.Facts.Apply(nil),
		Anecdotes: patch.Anecdotes.Apply(nil), News: patch.News.Apply(nil), Reviews: patch.Reviews.Apply(nil),
		Interview: patch.Interview.Apply(""), Sources: patch.Sources.Apply(nil), Notes: patch.Notes.Apply(""),
		ProfileFetchedAt: patch.ProfileFetchedAt.Apply(zeroTime), ReviewsFetchedAt: patch.ReviewsFetchedAt.Apply(zeroTime),
		Extras: extrasOf(patch.Extras),
	}
	company.Slug = readText(decoder, object, "slug")
	company.UpdatedAt = readMoment(decoder, object, "updatedAt")
	return company, decoder.Warnings()
}

func parseProfile(raw json.RawMessage) (domain.Profile, error) {
	var encoded profileJSON
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return domain.Profile{}, errors.New("must be an object")
	}
	return domain.Profile{
		Website: encoded.Website, CareersURL: encoded.CareersURL, LinkedIn: encoded.LinkedIn, HQ: encoded.HQ,
		Founded: encoded.Founded, Employees: encoded.Employees, CEO: encoded.CEO, Type: encoded.Type,
		Ticker: encoded.Ticker, Stage: encoded.Stage, Phone: encoded.Phone, PhoneLabel: encoded.PhoneLabel,
		RemotePolicy: encoded.RemotePolicy,
	}, nil
}

func parseFinancials(raw json.RawMessage) (domain.Financials, error) {
	var encoded financialsJSON
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return domain.Financials{}, errors.New("must be an object")
	}
	signal, err := domain.ParseHealthSignal(encoded.HealthSignal)
	if err != nil {
		return domain.Financials{}, err
	}
	financials := domain.Financials{
		TotalFunding: encoded.TotalFunding, TotalFundingUSD: encoded.TotalFundingUSD,
		Valuation: encoded.Valuation, ValuationUSD: encoded.ValuationUSD,
		Revenue: encoded.Revenue, RevenueUSD: encoded.RevenueUSD, Growth: encoded.Growth,
		Profitability: encoded.Profitability, MarketCap: encoded.MarketCap, StockNote: encoded.StockNote,
		Investors: encoded.Investors, HealthSignal: signal, HealthNote: encoded.HealthNote,
	}
	if round := encoded.LastRound; round != nil {
		financials.LastRound = &domain.FundingRound{
			Type: round.Type, Amount: round.Amount, AmountUSD: round.AmountUSD, Date: round.Date, LeadInvestors: round.LeadInvestors,
		}
	}
	if encoded.Layoffs != nil {
		financials.Layoffs = make([]domain.Layoff, len(encoded.Layoffs))
		for index, layoff := range encoded.Layoffs {
			financials.Layoffs[index] = domain.Layoff{Date: layoff.Date, Detail: layoff.Detail, URL: layoff.URL}
		}
	}
	return financials, nil
}

func parseAnecdotes(raw json.RawMessage) ([]domain.Anecdote, error) {
	encoded := []anecdoteJSON{}
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, errors.New("must be a list of anecdotes")
	}
	anecdotes := make([]domain.Anecdote, len(encoded))
	for index, item := range encoded {
		anecdotes[index] = domain.Anecdote{Text: item.Text, Source: item.Source, URL: item.URL}
	}
	return anecdotes, nil
}

func parseNews(raw json.RawMessage) ([]domain.NewsItem, error) {
	encoded := []newsJSON{}
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, errors.New("must be a list of news items")
	}
	news := make([]domain.NewsItem, len(encoded))
	for index, item := range encoded {
		news[index] = domain.NewsItem{Date: item.Date, Headline: item.Headline, Summary: item.Summary, Source: item.Source, URL: item.URL}
	}
	return news, nil
}

func parseReviews(raw json.RawMessage) ([]domain.Review, error) {
	encoded := []reviewJSON{}
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, errors.New("must be a list of reviews")
	}
	reviews := make([]domain.Review, len(encoded))
	for index, item := range encoded {
		fetchedAt, err := momentOrZero(item.FetchedAt)
		if err != nil {
			return nil, err
		}
		reviews[index] = domain.Review{
			Source: item.Source, Rating: item.Rating, RatingScale: item.RatingScale, ReviewCount: item.ReviewCount,
			Summary: item.Summary, Pros: item.Pros, Cons: item.Cons, URL: item.URL, FetchedAt: fetchedAt,
		}
	}
	return reviews, nil
}
