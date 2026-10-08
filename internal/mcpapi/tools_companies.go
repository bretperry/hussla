// Company tools: read company pages, fill a profile, add news and reviews.
// In the app: research agents' "get up to speed" work; the same calls as docs/agents-api.md's company routes.
// Used by: tools.go (catalog).
// Uses: the tracker use-case with the agent as actor, and the wire decoders the HTTP routes use.

package mcpapi

import (
	"context"

	"github.com/bretperry/hussla/internal/app/wire"
)

func companyTools() []tool {
	return []tool{
		{
			name: "list_companies", title: "List companies", route: "GET /api/companies", readOnly: true,
			description: "Every company page with its summary (quick take, best score, pay range, review and funding signals, jobs).",
			schema:      object(nil, props{}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args); err != nil {
					return nil, err
				}
				summaries, err := env.tracker.ListCompanies(ctx)
				if err != nil {
					return nil, err
				}
				encoded := make([]any, 0, len(summaries))
				for _, summary := range summaries {
					encoded = append(encoded, summaryJSON(summary))
				}
				return map[string]any{"companies": encoded}, nil
			},
		},
		{
			name: "get_company", title: "Get a company", route: "GET /api/companies/{slug}", readOnly: true,
			description: "One company page in full: profile, financials, news, reviews, its jobs, contacts and emails.",
			schema:      object([]string{"slug"}, props{"slug": str("the company slug, e.g. acme")}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "slug"); err != nil {
					return nil, err
				}
				slug, err := text(args, "slug", true)
				if err != nil {
					return nil, err
				}
				detail, err := env.tracker.GetCompany(ctx, slug)
				if err != nil {
					return nil, err //nolint:wrapcheck // mapped by describe
				}
				return companyDetailJSON(detail), nil
			},
		},
		{
			name: "upsert_company_profile", title: "Create or update a company profile", route: "PATCH /api/companies/{slug}", idempotent: true,
			description: "Fill in a company page. Creates it when the slug is new (then name is required); otherwise fields merge and arrays replace. " +
				"Only record facts you saw. notes is the owner's; don't overwrite. A field the owner last wrote can't be changed (the call says which).",
			schema: object([]string{"slug"}, props{
				"slug":             str("lowercase letters, digits and hyphens"),
				"name":             str("company name (required for a new page)"),
				"quickTake":        str("one or two sentences: what it is and whether it looks healthy"),
				"profile":          props{"type": "object", "description": "{website, careersUrl, linkedin, hq, founded, employees, ceo, type, ticker, stage, phone, phoneLabel, remotePolicy}"},
				"financials":       props{"type": "object", "description": "funding, valuation, revenue and layoffs; see docs/agents-api.md"},
				"facts":            strList("short facts (replaces the list)"),
				"anecdotes":        props{"type": "array", "items": props{"type": "object"}, "description": "[{text, source, url}] (replaces the list)"},
				"news":             props{"type": "array", "items": props{"type": "object"}, "description": "replaces the list; use add_company_news for one"},
				"reviews":          props{"type": "array", "items": props{"type": "object"}, "description": "replaces the list; use add_company_review for one"},
				"interview":        str("what the interview process is like, markdown"),
				"sources":          strList("URLs used (replaces the list)"),
				"notes":            str("the owner's own notes; don't overwrite"),
				"profileFetchedAt": str("ISO timestamp"), "reviewsFetchedAt": str("ISO timestamp"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				slug, err := text(args, "slug", true)
				if err != nil {
					return nil, err
				}
				decoder := &wire.Decoder{}
				patch, err := decoder.DecodeCompanyPatch(without(args, "slug"))
				if err != nil {
					return nil, err
				}
				company, err := env.tracker.PatchCompany(ctx, env.trackerActor(), slug, patch)
				if err != nil {
					return nil, err
				}
				return companyJSON(company), nil
			},
		},
		{
			name: "add_company_news", title: "Add a news item to a company", route: "POST /api/companies/{slug}/news", idempotent: true,
			description: "Add one news item (the same url replaces the earlier one). Kept newest first.",
			schema: object([]string{"slug", "headline"}, props{
				"slug": str("the company slug"), "date": str("YYYY-MM-DD"), "headline": str("the headline"),
				"summary": str("one or two sentences"), "source": str("publication"), "url": str("link to the article"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "slug", "date", "headline", "summary", "source", "url"); err != nil {
					return nil, err
				}
				slug, err := text(args, "slug", true)
				if err != nil {
					return nil, err
				}
				item, err := wire.DecodeNewsItem(marshalObject(without(args, "slug")))
				if err != nil {
					return nil, err
				}
				company, err := env.tracker.AddNews(ctx, env.trackerActor(), slug, item)
				if err != nil {
					return nil, err
				}
				return companyJSON(company), nil
			},
		},
		{
			name: "add_company_review", title: "Add a review summary to a company", route: "POST /api/companies/{slug}/reviews", idempotent: true,
			description: "Add or replace one review source (Glassdoor, Blind, ...) for a company. Record only ratings you actually saw.",
			schema: object([]string{"slug", "source"}, props{
				"slug": str("the company slug"), "source": str("e.g. Glassdoor"),
				"rating":      props{"type": []string{"number", "null"}, "description": "the rating you saw"},
				"ratingScale": props{"type": "number", "description": "the scale, usually 5"},
				"reviewCount": props{"type": []string{"integer", "null"}, "description": "how many reviews"},
				"summary":     str("one or two sentences"), "pros": strList("what people like"), "cons": strList("what people dislike"),
				"url": str("link to the reviews"), "fetchedAt": str("ISO timestamp"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "slug", "source", "rating", "ratingScale", "reviewCount", "summary", "pros", "cons", "url", "fetchedAt"); err != nil {
					return nil, err
				}
				slug, err := text(args, "slug", true)
				if err != nil {
					return nil, err
				}
				review, err := wire.DecodeReview(marshalObject(without(args, "slug")))
				if err != nil {
					return nil, err
				}
				company, err := env.tracker.SaveReview(ctx, env.trackerActor(), slug, review)
				if err != nil {
					return nil, err
				}
				return companyJSON(company), nil
			},
		},
	}
}
