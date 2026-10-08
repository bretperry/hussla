// Fixtures for the storage contract suite: records with every field filled, and generators for property tests.
// In the app: nothing at runtime (tests only).
// Used by: contract.go and the property tests in this package.
// Uses: internal/domain, internal/app/files, internal/app/tokens, pgregory.net/rapid.
//
// All synthetic: example.com addresses and made-up names. Times are whole milliseconds in UTC,
// the only form the domain holds, so a round trip must give back exactly what went in. Lists
// may be nil or empty; both must come back as they went in.

package storecontract

import (
	"time"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/domain"
)

// at is a fixed moment plus whole minutes, in UTC.
func at(minutes int) time.Time {
	return time.Date(2026, 9, 1, 12, 0, 0, 123_000_000, time.UTC).Add(time.Duration(minutes) * time.Minute)
}

func intPointer(value int) *int       { return &value }
func int64Pointer(value int64) *int64 { return &value }
func floatPointer(v float64) *float64 { return &v }

// fullJob has every field set, nested lists, a follow-up, extras and owner-written fields.
func fullJob(id string) domain.Job {
	return domain.Job{
		ID: id, CompanySlug: "acme-robotics", CreatedAt: at(0), UpdatedAt: at(5),
		Company: "Acme Robotics", Title: "Senior Engineer", Status: domain.JobStatusInterviewing, StatusNote: "phone screen done",
		Score: intPointer(72), URL: "https://example.com/jobs/1", Location: "Springfield", WorkType: domain.WorkTypeHybrid,
		SalaryMin: intPointer(150000), SalaryMax: intPointer(190000), PayText: "$150-190k", Compensation: "Base plus bonus",
		Source: "Greenhouse", Resume: "example-resume-staff", ResumeSent: "example-resume-staff.pdf",
		FoundAt: at(-60), AppliedAt: at(10), NextAction: "Send thank-you", NextActionDue: "2026-09-03",
		HeadsUp: "Posting closes Friday", Description: "A **great** role.\n\nWith <b>markup</b> & ampersands.",
		DescriptionFetchedAt: at(1), PostingStatus: domain.PostingStatusOpen, WhyScore: "Good match",
		Reasons: []string{"remote friendly", "strong team"}, ScamFlags: []string{"vague pay"},
		Contacts: []domain.Contact{
			{Priority: "Primary", Name: "Jane Example", Role: "Recruiter", Email: "jane@example.com", EmailStatus: domain.EmailCheckVerified, Phone: "555-0100", LinkedIn: "https://example.com/in/jane", Source: "posting", Notes: "prefers email"},
			{Name: "Sam Sample", EmailStatus: domain.EmailCheckNotFound},
		},
		BestChannel: "Email Jane first",
		Followup: domain.Followup{
			To: "jane@example.com", Subject: "Following up", Body: "Hello,\nThanks for your time.", LinkedIn: "Sent a note", CallNotes: "Left a voicemail",
			EmailSentAt: at(20), LinkedInSentAt: at(21), CallMadeAt: at(22),
		},
		CompanyNotes: "Series B", RoleNotes: "Owns the platform", Sources: []string{"https://example.com/a", "https://example.com/b"},
		Notes: "Bret's own note",
		Extras: domain.Extras{
			"xNumber": `3`, "xText": `"hello \"there\""`, "xObject": `{"a":[1,2,{"b":null}]}`, "xList": `["a","b"]`, "xBool": `true`,
		},
		Writers: domain.FieldWriters{"notes": domain.WriterOwner, "followup.body": domain.WriterOwner, "xText": domain.WriterOwner},
	}
}

// bareJob has only what NewJob requires, with every optional left empty or nil.
func bareJob(id string) domain.Job {
	return domain.Job{ID: id, CompanySlug: "bare-co", CreatedAt: at(0), UpdatedAt: at(0), Company: "Bare Co", Title: "Role", Status: domain.JobStatusReview}
}

// fullCompany has every field set.
func fullCompany(slug, name string) domain.Company {
	return domain.Company{
		Slug: slug, Name: name, UpdatedAt: at(7), QuickTake: "A robotics maker.",
		Profile: domain.Profile{
			Website: "https://example.com", CareersURL: "https://example.com/careers", LinkedIn: "https://example.com/in/acme", HQ: "Springfield",
			Founded: intPointer(2015), Employees: "about 900 (example, 2026)", CEO: "Pat Example", Type: "private", Ticker: "", Stage: "Series B",
			Phone: "555-0199", PhoneLabel: "Main line", RemotePolicy: "hybrid",
		},
		Financials: domain.Financials{
			TotalFunding: "$80M", TotalFundingUSD: int64Pointer(80_000_000),
			LastRound: &domain.FundingRound{Type: "Series B", Amount: "$40M", AmountUSD: int64Pointer(40_000_000), Date: "2025-06", LeadInvestors: []string{"Example Capital"}},
			Valuation: "$400M", ValuationUSD: int64Pointer(400_000_000), Revenue: "$20M", RevenueUSD: int64Pointer(20_000_000),
			Growth: "40% year over year", Profitability: "not yet", MarketCap: "", StockNote: "",
			Investors:    []string{"Example Capital", "Sample Ventures"},
			Layoffs:      []domain.Layoff{{Date: "2026-03", Detail: "10% of staff", URL: "https://example.com/news/layoffs"}},
			HealthSignal: domain.HealthSignalSteady, HealthNote: "Runway of 3 years",
		},
		Facts:     []string{"Founded in 2015", "Builds warehouse robots"},
		Anecdotes: []domain.Anecdote{{Text: "Lunch is free", Source: "Example Reviews", URL: "https://example.com/a1"}},
		News:      []domain.NewsItem{{Date: "2026-08-28", Headline: "Acme raises", Summary: "Series B", Source: "Example News", URL: "https://example.com/n1"}},
		Reviews: []domain.Review{
			{Source: "Example Reviews", Rating: floatPointer(4.1), RatingScale: 5, ReviewCount: intPointer(120), Summary: "Mostly happy", Pros: []string{"pay"}, Cons: []string{"hours", "process"}, URL: "https://example.com/r1", FetchedAt: at(2)},
			{Source: "Other Reviews", Rating: nil, Summary: "No rating seen"},
		},
		Interview: "Three rounds.", Sources: []string{"https://example.com/s"}, Notes: "owner note",
		ProfileFetchedAt: at(3), ReviewsFetchedAt: at(4),
		Extras:  domain.Extras{"xTag": `"robots"`, "xScore": `9.5`},
		Writers: domain.FieldWriters{"notes": domain.WriterOwner},
	}
}

func fullAnswer(id string) domain.Answer {
	return domain.Answer{
		ID: id, Question: "Are you authorized to work here?", Answer: "Yes.", JobIDs: []string{"job-a", "job-b"},
		CreatedAt: at(0), AnsweredAt: at(3), Writers: domain.FieldWriters{"answer": domain.WriterOwner},
	}
}

func fullEmail(id string) domain.Email {
	return domain.Email{
		ID: id, JobID: "job-a", CompanySlug: "acme-robotics", To: []string{"jane@example.com"}, Cc: []string{"sam@example.com", "lee@example.com"},
		Subject: "Following up", Body: "Hello,\n\nThanks.", Kind: domain.EmailKindFollowUp, Status: domain.EmailStatusSent,
		CreatedBy: "agent:laptop", CreatedAt: at(0), ApprovedBy: "Bret", ApprovedAt: at(2), SentAt: at(6), MessageID: "<id@example.com>",
		Error: "earlier hiccup", Attempts: 2, Version: 4,
	}
}

// draftEmail is a fresh draft, as domain.NewEmail makes one.
func draftEmail(id string, created time.Time) domain.Email {
	return domain.Email{
		ID: id, To: []string{"jane@example.com"}, Subject: "Hello", Body: "Body text", Kind: domain.EmailKindNote,
		Status: domain.EmailStatusDraft, CreatedBy: "agent:laptop", CreatedAt: created, Version: 1,
	}
}

// --- generators (property tests)

func genTime() *rapid.Generator[time.Time] {
	return rapid.Custom(func(t *rapid.T) time.Time {
		if rapid.Bool().Draw(t, "unset") {
			return time.Time{}
		}
		return time.UnixMilli(rapid.Int64Range(0, 4_000_000_000_000).Draw(t, "millis")).UTC()
	})
}

func genOptionalInt() *rapid.Generator[*int] {
	return rapid.Custom(func(t *rapid.T) *int {
		if rapid.Bool().Draw(t, "nil") {
			return nil
		}
		return intPointer(rapid.IntRange(0, 1_000_000).Draw(t, "n"))
	})
}

func genOptionalBigInt() *rapid.Generator[*int64] {
	return rapid.Custom(func(t *rapid.T) *int64 {
		if rapid.Bool().Draw(t, "nil") {
			return nil
		}
		return int64Pointer(rapid.Int64Range(0, 1<<50).Draw(t, "n"))
	})
}

// genList is nil, empty or a short list: "no list" and "an empty list" must both survive.
func genList() *rapid.Generator[[]string] {
	return rapid.Custom(func(t *rapid.T) []string {
		if rapid.Bool().Draw(t, "nil") {
			return nil
		}
		return rapid.SliceOfN(rapid.String(), 0, 3).Draw(t, "items")
	})
}

func genExtras() *rapid.Generator[domain.Extras] {
	return rapid.Custom(func(t *rapid.T) domain.Extras {
		if rapid.Bool().Draw(t, "nil") {
			return nil
		}
		values := []domain.RawJSON{`1`, `"text"`, `{"a":1}`, `[1,2]`, `true`, `-2.5`}
		keys := rapid.SliceOfNDistinct(rapid.StringMatching(`x[A-Za-z]{1,8}`), 1, 3, func(key string) string { return key }).Draw(t, "keys")
		extras := domain.Extras{}
		for _, key := range keys {
			extras[key] = rapid.SampledFrom(values).Draw(t, "value")
		}
		return extras
	})
}

func genWriters(names []string) *rapid.Generator[domain.FieldWriters] {
	return rapid.Custom(func(t *rapid.T) domain.FieldWriters {
		chosen := rapid.SliceOfNDistinct(rapid.SampledFrom(names), 0, 3, func(name string) string { return name }).Draw(t, "owned")
		if len(chosen) == 0 {
			return nil
		}
		writers := domain.FieldWriters{}
		for _, name := range chosen {
			writers[name] = domain.WriterOwner
		}
		return writers
	})
}

func genJob() *rapid.Generator[domain.Job] {
	return rapid.Custom(func(t *rapid.T) domain.Job {
		contacts := rapid.Custom(func(t *rapid.T) []domain.Contact {
			if rapid.Bool().Draw(t, "nil") {
				return nil
			}
			return rapid.SliceOfN(rapid.Custom(func(t *rapid.T) domain.Contact {
				return domain.Contact{
					Priority: rapid.String().Draw(t, "priority"), Name: rapid.String().Draw(t, "name"), Role: rapid.String().Draw(t, "role"),
					Email: rapid.String().Draw(t, "email"), EmailStatus: domain.EmailCheck(rapid.IntRange(0, 3).Draw(t, "check")),
					Phone: rapid.String().Draw(t, "phone"), LinkedIn: rapid.String().Draw(t, "linkedin"),
					Source: rapid.String().Draw(t, "source"), Notes: rapid.String().Draw(t, "notes"),
				}
			}), 1, 3).Draw(t, "contacts")
		}).Draw(t, "contacts")
		return domain.Job{
			ID: rapid.StringMatching(`[a-z0-9-]{1,40}`).Draw(t, "id"), CompanySlug: rapid.StringMatching(`[a-z0-9-]{0,20}`).Draw(t, "slug"),
			CreatedAt: at(0), UpdatedAt: genTime().Draw(t, "updatedAt"),
			Company: rapid.String().Draw(t, "company"), Title: rapid.String().Draw(t, "title"),
			Status: domain.JobStatus(rapid.IntRange(0, 11).Draw(t, "status")), StatusNote: rapid.String().Draw(t, "statusNote"),
			Score: genOptionalInt().Draw(t, "score"), URL: rapid.String().Draw(t, "url"), Location: rapid.String().Draw(t, "location"),
			WorkType:  domain.WorkType(rapid.IntRange(0, 3).Draw(t, "workType")),
			SalaryMin: genOptionalInt().Draw(t, "salaryMin"), SalaryMax: genOptionalInt().Draw(t, "salaryMax"),
			PayText: rapid.String().Draw(t, "payText"), Compensation: rapid.String().Draw(t, "compensation"),
			Source: rapid.String().Draw(t, "source"), Resume: rapid.String().Draw(t, "resume"), ResumeSent: rapid.String().Draw(t, "resumeSent"),
			FoundAt: genTime().Draw(t, "foundAt"), AppliedAt: genTime().Draw(t, "appliedAt"),
			NextAction: rapid.String().Draw(t, "nextAction"), NextActionDue: rapid.String().Draw(t, "nextActionDue"),
			HeadsUp: rapid.String().Draw(t, "headsUp"), Description: rapid.String().Draw(t, "description"),
			DescriptionFetchedAt: genTime().Draw(t, "descriptionFetchedAt"),
			PostingStatus:        domain.PostingStatus(rapid.IntRange(0, 2).Draw(t, "postingStatus")),
			WhyScore:             rapid.String().Draw(t, "whyScore"), Reasons: genList().Draw(t, "reasons"), ScamFlags: genList().Draw(t, "scamFlags"),
			Contacts: contacts, BestChannel: rapid.String().Draw(t, "bestChannel"),
			Followup: domain.Followup{
				To: rapid.String().Draw(t, "to"), Subject: rapid.String().Draw(t, "subject"), Body: rapid.String().Draw(t, "body"),
				LinkedIn: rapid.String().Draw(t, "linkedin"), CallNotes: rapid.String().Draw(t, "callNotes"),
				EmailSentAt: genTime().Draw(t, "emailSentAt"), LinkedInSentAt: genTime().Draw(t, "linkedinSentAt"), CallMadeAt: genTime().Draw(t, "callMadeAt"),
			},
			CompanyNotes: rapid.String().Draw(t, "companyNotes"), RoleNotes: rapid.String().Draw(t, "roleNotes"),
			Sources: genList().Draw(t, "sources"), Notes: rapid.String().Draw(t, "notes"),
			Extras: genExtras().Draw(t, "extras"), Writers: genWriters([]string{"notes", "title", "followup.body", "xA"}).Draw(t, "writers"),
		}
	})
}

func genCompany() *rapid.Generator[domain.Company] {
	return rapid.Custom(func(t *rapid.T) domain.Company {
		var lastRound *domain.FundingRound
		if rapid.Bool().Draw(t, "hasRound") {
			lastRound = &domain.FundingRound{
				Type: rapid.String().Draw(t, "roundType"), Amount: rapid.String().Draw(t, "amount"), AmountUSD: genOptionalBigInt().Draw(t, "amountUsd"),
				Date: rapid.String().Draw(t, "date"), LeadInvestors: genList().Draw(t, "leads"),
			}
		}
		var layoffs []domain.Layoff
		if rapid.Bool().Draw(t, "hasLayoffs") {
			layoffs = []domain.Layoff{{Date: rapid.String().Draw(t, "ld"), Detail: rapid.String().Draw(t, "detail"), URL: rapid.String().Draw(t, "lu")}}
		}
		var reviews []domain.Review
		if rapid.Bool().Draw(t, "hasReviews") {
			var rating *float64
			if rapid.Bool().Draw(t, "hasRating") {
				rating = floatPointer(rapid.Float64Range(0, 5).Draw(t, "rating"))
			}
			reviews = []domain.Review{{
				Source: rapid.String().Draw(t, "src"), Rating: rating, RatingScale: rapid.SampledFrom([]float64{0, 5, 10}).Draw(t, "scale"),
				ReviewCount: genOptionalInt().Draw(t, "count"), Summary: rapid.String().Draw(t, "summary"),
				Pros: genList().Draw(t, "pros"), Cons: genList().Draw(t, "cons"), URL: rapid.String().Draw(t, "ru"), FetchedAt: genTime().Draw(t, "fetched"),
			}}
		}
		var anecdotes []domain.Anecdote
		if rapid.Bool().Draw(t, "hasAnecdotes") {
			anecdotes = []domain.Anecdote{{Text: rapid.String().Draw(t, "at"), Source: rapid.String().Draw(t, "as"), URL: rapid.String().Draw(t, "au")}}
		}
		var news []domain.NewsItem
		if rapid.Bool().Draw(t, "hasNews") {
			news = []domain.NewsItem{{Date: rapid.String().Draw(t, "nd"), Headline: rapid.String().Draw(t, "nh"), Summary: rapid.String().Draw(t, "ns"), Source: rapid.String().Draw(t, "nso"), URL: rapid.String().Draw(t, "nu")}}
		}
		return domain.Company{
			Slug: rapid.StringMatching(`[a-z0-9-]{1,40}`).Draw(t, "slug"), Name: rapid.String().Draw(t, "name"), UpdatedAt: at(0),
			QuickTake: rapid.String().Draw(t, "quickTake"),
			Profile: domain.Profile{
				Website: rapid.String().Draw(t, "website"), HQ: rapid.String().Draw(t, "hq"), Founded: genOptionalInt().Draw(t, "founded"),
				Employees: rapid.String().Draw(t, "employees"), Phone: rapid.String().Draw(t, "phone"),
			},
			Financials: domain.Financials{
				TotalFunding: rapid.String().Draw(t, "funding"), TotalFundingUSD: genOptionalBigInt().Draw(t, "fundingUsd"), LastRound: lastRound,
				Investors: genList().Draw(t, "investors"), Layoffs: layoffs, HealthSignal: domain.HealthSignal(rapid.IntRange(0, 4).Draw(t, "signal")),
			},
			Facts: genList().Draw(t, "facts"), Anecdotes: anecdotes, News: news, Reviews: reviews,
			Interview: rapid.String().Draw(t, "interview"), Sources: genList().Draw(t, "sources"), Notes: rapid.String().Draw(t, "notes"),
			ProfileFetchedAt: genTime().Draw(t, "pf"), ReviewsFetchedAt: genTime().Draw(t, "rf"),
			Extras: genExtras().Draw(t, "extras"), Writers: genWriters([]string{"notes", "quickTake", "xA"}).Draw(t, "writers"),
		}
	})
}
