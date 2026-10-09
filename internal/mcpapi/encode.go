// Tool results: domain records as the same JSON the HTTP API sends.
// In the app: what an agent reads back from every tool, so a field means one thing on both doors.
// Used by: the tool files in this package.
// Uses: internal/app/wire for jobs, companies, contacts and answers (the codec storage and httpapi share).
//
// These mirror internal/httpapi/encode.go on purpose: httpapi is a sibling layer and can't be imported,
// and moving the shapes into wire would reshape the Phase 3 PR. TestToolsReturnWhatTheAPIReturns
// compares each read tool to its HTTP route so the two can't drift unnoticed.

package mcpapi

import (
	"encoding/json"
	"time"

	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

func moment(at time.Time) *string {
	if at.IsZero() {
		return nil
	}
	text := domain.FormatTimestamp(at)
	return &text
}

func nullable(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

func raw(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic("mcpapi: encode: " + err.Error()) // plain values only; a failure is a programming error
	}
	return encoded
}

func jobJSON(job domain.Job) wire.Object {
	object := wire.JobObject(job)
	wire.EmptyListsForNull(object, wire.JobListFields)
	object["writers"] = wire.WritersObject(job.Writers)
	return object
}

func companyJSON(company domain.Company) wire.Object {
	object := wire.CompanyObject(company)
	wire.EmptyListsForNull(object, wire.CompanyListFields)
	object["writers"] = wire.WritersObject(company.Writers)
	return object
}

func answerJSON(answer domain.Answer) wire.Object {
	object := wire.AnswerObject(answer)
	object["writers"] = wire.WritersObject(answer.Writers)
	return object
}

var jobListKeys = []string{
	"id", "companySlug", "createdAt", "updatedAt", "company", "title", "status", "score", "url", "location",
	"workType", "salaryMin", "salaryMax", "payText", "source", "resume", "resumeSent", "foundAt", "appliedAt",
	"nextAction", "nextActionDue", "headsUp",
}

func jobListItemJSON(job domain.Job) wire.Object {
	full := wire.JobObject(job)
	item := wire.Object{}
	for _, key := range jobListKeys {
		item[key] = full[key]
	}
	item["followup"] = raw(map[string]*string{
		"emailSentAt": moment(job.Followup.EmailSentAt), "linkedinSentAt": moment(job.Followup.LinkedInSentAt), "callMadeAt": moment(job.Followup.CallMadeAt),
	})
	item["primaryContact"] = json.RawMessage("null")
	if len(job.Contacts) > 0 {
		item["primaryContact"] = raw(wire.ContactObject(job.Contacts[0]))
	}
	return item
}

type eventJSON struct {
	ID     int64   `json:"id"`
	JobID  *string `json:"jobId"`
	At     *string `json:"at"`
	Actor  string  `json:"actor"`
	Action string  `json:"action"`
	Detail string  `json:"detail"`
}

func eventToJSON(event domain.Event) eventJSON {
	return eventJSON{ID: event.ID, JobID: nullable(event.JobID), At: moment(event.At), Actor: event.Actor, Action: event.Action, Detail: event.Detail}
}

type fileJSON struct {
	ID        string  `json:"id"`
	JobID     *string `json:"jobId"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Mime      string  `json:"mime"`
	Size      int64   `json:"size"`
	CreatedAt *string `json:"createdAt"`
	Actor     string  `json:"actor"`
	URL       string  `json:"url"`
}

func fileToJSON(file files.File) fileJSON {
	return fileJSON{
		ID: file.ID, JobID: nullable(file.JobID), Name: file.Name, Kind: file.Kind, Mime: file.Mime, Size: file.Size,
		CreatedAt: moment(file.CreatedAt), Actor: file.Actor, URL: "/api/files/" + file.ID,
	}
}

type emailJSON struct {
	ID          string   `json:"id"`
	JobID       *string  `json:"jobId"`
	CompanySlug *string  `json:"companySlug"`
	To          []string `json:"to"`
	Cc          []string `json:"cc"`
	Subject     string   `json:"subject"`
	Body        string   `json:"body"`
	Kind        string   `json:"kind"`
	Status      string   `json:"status"`
	CreatedBy   string   `json:"createdBy"`
	CreatedAt   *string  `json:"createdAt"`
	ApprovedBy  *string  `json:"approvedBy"`
	ApprovedAt  *string  `json:"approvedAt"`
	SentAt      *string  `json:"sentAt"`
	MessageID   *string  `json:"messageId"`
	Error       *string  `json:"error"`
	Attempts    int      `json:"attempts"`
	Version     int      `json:"version"`
}

func emailToJSON(email domain.Email) emailJSON {
	nonNil := func(list []string) []string {
		if list == nil {
			return []string{}
		}
		return list
	}
	return emailJSON{
		ID: email.ID, JobID: nullable(email.JobID), CompanySlug: nullable(email.CompanySlug), To: nonNil(email.To), Cc: nonNil(email.Cc),
		Subject: email.Subject, Body: email.Body, Kind: string(email.Kind), Status: email.Status.String(), CreatedBy: email.CreatedBy,
		CreatedAt: moment(email.CreatedAt), ApprovedBy: nullable(email.ApprovedBy), ApprovedAt: moment(email.ApprovedAt),
		SentAt: moment(email.SentAt), MessageID: nullable(email.MessageID), Error: nullable(email.Error), Attempts: email.Attempts, Version: email.Version,
	}
}

func emailsToJSON(list []domain.Email) []emailJSON {
	encoded := make([]emailJSON, 0, len(list))
	for _, email := range list {
		encoded = append(encoded, emailToJSON(email))
	}
	return encoded
}

// jobDetailJSON is a job with its company page, activity, files and emails (GET /api/jobs/{id}).
func jobDetailJSON(detail tracker.JobDetail) wire.Object {
	object := jobJSON(detail.Job)
	object["companyInfo"] = json.RawMessage("null")
	if detail.Company != nil {
		object["companyInfo"] = raw(companyJSON(*detail.Company))
	}
	events := make([]eventJSON, 0, len(detail.Events))
	for _, event := range detail.Events {
		events = append(events, eventToJSON(event))
	}
	attached := make([]fileJSON, 0, len(detail.Files))
	for _, file := range detail.Files {
		attached = append(attached, fileToJSON(file))
	}
	object["events"], object["files"], object["emails"] = raw(events), raw(attached), raw(emailsToJSON(detail.Emails))
	return object
}

func summaryJSON(summary domain.CompanySummary) json.RawMessage {
	briefs := make([]map[string]any, 0, len(summary.Jobs))
	for _, brief := range summary.Jobs {
		briefs = append(briefs, map[string]any{
			"id": brief.ID, "title": brief.Title, "status": brief.Status.String(), "score": brief.Score,
			"payText": brief.PayText, "salaryMin": brief.SalaryMin, "salaryMax": brief.SalaryMax,
		})
	}
	return raw(map[string]any{
		"slug": summary.Slug, "name": summary.Name, "quickTake": summary.QuickTake, "jobs": briefs,
		"bestScore": summary.BestScore, "payMin": summary.PayMin, "payMax": summary.PayMax,
		"glassdoor": summary.Glassdoor, "glassdoorCount": summary.GlassdoorCount, "avgRating": summary.AvgRating,
		"healthSignal": summary.HealthSignal.String(), "healthRank": summary.HealthRank, "healthNote": summary.HealthNote,
		"totalFunding": summary.TotalFunding, "totalFundingUsd": summary.TotalFundingUSD,
		"valuation": summary.Valuation, "valuationUsd": summary.ValuationUSD, "revenue": summary.Revenue,
		"employees": summary.Employees, "hq": summary.HQ, "founded": summary.Founded, "stage": summary.Stage,
		"remotePolicy": summary.RemotePolicy, "phone": summary.Phone, "layoffs": summary.LayoffCount,
		"newsCount": summary.NewsCount, "updatedAt": moment(summary.UpdatedAt),
	})
}

// companyDetailJSON is a company page with its summary, jobs, emails and job contacts (GET /api/companies/{slug}).
func companyDetailJSON(detail tracker.CompanyDetail) wire.Object {
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
	return object
}
