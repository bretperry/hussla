// Every JSON read route answers the contract's shape on a near-empty install: one bare job, bare companies.
// In the app: the first NAS install crashed the front page on a company whose never-set lists answered null.
// Used by: `go test ./internal/httpapi/...`.
// Uses: the rig (each answer is checked against api/openapi.yaml in rig.do), the in-memory store to seed bare companies.

package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// emptyStateSkipped are the documented GETs that don't answer JSON, so there's no schema to check.
var emptyStateSkipped = map[string]string{
	"/api/docs":           "markdown",
	"/api/files/{fileId}": "the file's own bytes",
	"/api/setup/qr":       "an SVG",
	"/signin":             "a redirect",
}

func TestEmptyStateReadsMatchTheContract(t *testing.T) {
	r := newRig(t).enroll()
	jobID := r.newJob("Engineer") // only the required fields; its company is made with nothing set
	seedCompanies(t, r,
		// No optional data at all.
		domain.Company{Slug: "bare-co", Name: "Bare Co", UpdatedAt: r.clock.Now()},
		// Nested records with their own lists unset.
		domain.Company{
			Slug: "nested-co", Name: "Nested Co", UpdatedAt: r.clock.Now(),
			Financials: domain.Financials{LastRound: &domain.FundingRound{Type: "Seed"}},
			Reviews:    []domain.Review{{Source: "Glassdoor", RatingScale: 5, FetchedAt: r.clock.Now()}},
		},
	)

	reads := map[string][]string{
		"/healthz":              {"/healthz"},
		"/api":                  {"/api"},
		"/api/me":               {"/api/me"},
		"/api/jobs":             {"/api/jobs"},
		"/api/jobs/{jobId}":     {"/api/jobs/" + jobID},
		"/api/companies":        {"/api/companies"},
		"/api/companies/{slug}": {"/api/companies/example-co", "/api/companies/bare-co", "/api/companies/nested-co"},
		"/api/events":           {"/api/events"},
		"/api/answers":          {"/api/answers"},
		"/api/pitches":          {"/api/pitches"},
		"/api/config":           {"/api/config"},
		"/api/resumes":          {"/api/resumes"},
		"/api/stats":            {"/api/stats"},
		"/api/tokens":           {"/api/tokens"},
		"/api/export":           {"/api/export"},
		"/api/mail":             {"/api/mail"},
		"/api/mail/providers":   {"/api/mail/providers"},
		"/api/mail/settings":    {"/api/mail/settings"},
		"/api/search":           {"/api/search"},
		"/api/emails":           {"/api/emails"},
		"/api/setup":            {"/api/setup"},
		"/api/passkeys":         {"/api/passkeys"},
	}

	// A GET added to the contract must be read here too (or named as not JSON above).
	contract, err := theResponseContract()
	if err != nil {
		t.Fatal(err)
	}
	for _, template := range contract.templates {
		if _, isGet := contract.lookup("#/paths/" + escapePointer(template) + "/get"); !isGet {
			continue
		}
		if _, read := reads[template]; !read && emptyStateSkipped[template] == "" {
			t.Errorf("GET %s is in api/openapi.yaml but not read by this test", template)
		}
	}

	for template, paths := range reads {
		for _, path := range paths {
			got := r.must(http.StatusOK, call{path: path})
			// rig.do validates JSON answers only, so a route that stopped answering JSON would skip the check.
			if contentType := got.header.Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
				t.Errorf("GET %s (%s): Content-Type %q, want application/json", path, template, contentType)
			}
		}
	}
}

// seedCompanies stores companies directly, so they can hold shapes the API wouldn't write.
func seedCompanies(t *testing.T, r *rig, companies ...domain.Company) {
	t.Helper()
	err := r.store.Atomically(context.Background(), func(tx store.Tx) error {
		for _, company := range companies {
			if err := tx.Companies().Create(context.Background(), company); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(time.Millisecond)
}
