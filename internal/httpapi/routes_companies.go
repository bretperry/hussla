// Company routes: the companies table, the company page, profile patches, one news item, one review.
// In the app: Companies, Compare, the company page; "Company profiles" in docs/agents-api.md.
// Used by: server.go's route table.

package httpapi

import (
	"net/http"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/wire"
)

func (server *api) listCompanies(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	summaries, err := server.deps.Tracker.ListCompanies(r.Context())
	if err != nil {
		return err
	}
	encoded := make([]any, 0, len(summaries))
	for _, summary := range summaries {
		encoded = append(encoded, summaryJSON(summary))
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

func (server *api) getCompany(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	detail, err := server.deps.Tracker.GetCompany(r.Context(), r.PathValue("slug"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	object := companyJSON(detail.Company)
	object["summary"] = summaryJSON(detail.Summary)
	jobs := make([]wire.Object, 0, len(detail.Jobs))
	contacts := make([]wire.Object, 0)
	for _, job := range detail.Jobs {
		jobs = append(jobs, jobJSON(job))
		for _, contact := range job.Contacts {
			entry := wire.ContactObject(contact)
			entry["jobId"], entry["jobTitle"] = raw(job.ID), raw(job.Title)
			contacts = append(contacts, entry)
		}
	}
	object["jobs"], object["emails"], object["jobContacts"] = raw(jobs), raw(emailsToJSON(detail.Emails)), raw(contacts)
	writeJSON(w, http.StatusOK, object)
	return nil
}

func (server *api) patchCompany(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	object, err := readObject(r)
	if err != nil {
		return err
	}
	decoder := &wire.Decoder{}
	patch, err := decoder.DecodeCompanyPatch(object)
	if err != nil {
		return err
	}
	company, err := server.deps.Tracker.PatchCompany(r.Context(), actorOf(caller), r.PathValue("slug"), patch)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, companyJSON(company))
	return nil
}

func (server *api) addNews(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	body, err := readBody(r, 1<<20)
	if err != nil {
		return err
	}
	item, err := wire.DecodeNewsItem(body)
	if err != nil {
		return err
	}
	company, err := server.deps.Tracker.AddNews(r.Context(), actorOf(caller), r.PathValue("slug"), item)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, companyJSON(company))
	return nil
}

func (server *api) saveReview(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	body, err := readBody(r, 1<<20)
	if err != nil {
		return err
	}
	review, err := wire.DecodeReview(body)
	if err != nil {
		return err
	}
	company, err := server.deps.Tracker.SaveReview(r.Context(), actorOf(caller), r.PathValue("slug"), review)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, companyJSON(company))
	return nil
}
