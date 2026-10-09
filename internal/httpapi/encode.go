// Response shapes: domain records as the contract's JSON (api/openapi.yaml components).
// In the app: every GET body and every write's echo.
// Used by: the route files.
// Uses: internal/app/wire for jobs, companies, contacts and answers (the same codec storage uses).

package httpapi

import (
	"encoding/json"
	"time"

	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/tokens"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// moment is a timestamp as the contract writes it, or nil (null).
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
		panic("httpapi: encode: " + err.Error()) // plain values only; a failure is a programming error
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
	wire.EmptyCompanyListsForNull(object)
	object["writers"] = wire.WritersObject(company.Writers)
	return object
}

func answerJSON(answer domain.Answer) wire.Object {
	object := wire.AnswerObject(answer)
	object["writers"] = wire.WritersObject(answer.Writers)
	return object
}

// jobListKeys are the JobListItem keys copied from the full job object.
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
	ID      int64   `json:"id"`
	JobID   *string `json:"jobId"`
	At      *string `json:"at"`
	Actor   string  `json:"actor"`
	Action  string  `json:"action"`
	Detail  string  `json:"detail"`
	Company *string `json:"company,omitempty"`
	Title   *string `json:"title,omitempty"`
}

func eventToJSON(event domain.Event) eventJSON {
	return eventJSON{ID: event.ID, JobID: nullable(event.JobID), At: moment(event.At), Actor: event.Actor, Action: event.Action, Detail: event.Detail}
}

func eventLineJSON(line tracker.EventLine) eventJSON {
	encoded := eventToJSON(line.Event)
	if line.Event.JobID != "" {
		encoded.Company, encoded.Title = &line.Company, &line.Title
	}
	return encoded
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

type agentKeyJSON struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	CreatedAt  *string `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
}

func agentKeyToJSON(token tokens.Token) agentKeyJSON {
	return agentKeyJSON{ID: token.ID, Name: token.Name, CreatedAt: moment(token.CreatedAt), LastUsedAt: moment(token.LastUsedAt), RevokedAt: moment(token.RevokedAt)}
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

func resumeJSON(resume attachments.Resume) map[string]any {
	variant := resume.Name
	for index := len(variant) - 1; index > 0; index-- {
		if variant[index] == '.' {
			variant = variant[:index]
			break
		}
	}
	return map[string]any{"name": resume.Name, "variant": variant, "url": "/resumes/" + resume.Name, "size": resume.Size}
}
