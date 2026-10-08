// Job, contact, activity and file routes.
// In the app: the jobs table, the job page, and the agent calls in docs/agents-api.md.
// Used by: server.go's route table.

package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

func actorOf(caller auth.Principal) tracker.Actor {
	return tracker.Actor{Name: caller.Actor(), Writer: caller.Writer()}
}

// parseStatuses reads "review,queued".
func parseStatuses(text string) ([]domain.JobStatus, error) {
	var statuses []domain.JobStatus
	for _, name := range strings.Split(text, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		status, err := domain.ParseJobStatus(name)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, nil
}

func (server *api) listJobs(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	statuses, err := parseStatuses(r.URL.Query().Get("status"))
	if err != nil {
		return err
	}
	list, err := server.deps.Tracker.ListJobs(r.Context(), tracker.JobQuery{Statuses: statuses, Text: r.URL.Query().Get("q")})
	if err != nil {
		return err
	}
	items := make([]wire.Object, 0, len(list))
	for _, job := range list {
		items = append(items, jobListItemJSON(job))
	}
	writeJSON(w, http.StatusOK, items)
	return nil
}

// readJobWrite reads a job body: the patch, the `note`, and (for create) the `id`.
func readJobWrite(r *http.Request) (tracker.JobWrite, string, error) {
	object, err := readObject(r)
	if err != nil {
		return tracker.JobWrite{}, "", err
	}
	var write tracker.JobWrite
	var id string
	for key, target := range map[string]*string{"note": &write.Note, "id": &id} {
		if value, present := object[key]; present {
			if err := json.Unmarshal(value, target); err != nil {
				return tracker.JobWrite{}, "", &domain.ValidationError{Field: key, Problem: "must be text"}
			}
		}
	}
	decoder := &wire.Decoder{}
	write.Patch, err = decoder.DecodeJobPatch(object)
	if err != nil {
		return tracker.JobWrite{}, "", err
	}
	return write, id, nil
}

func (server *api) createJob(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	write, id, err := readJobWrite(r)
	if err != nil {
		return err
	}
	job, err := server.deps.Tracker.CreateJob(r.Context(), actorOf(caller), id, write)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, jobJSON(job))
	return nil
}

func (server *api) getJob(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	detail, err := server.deps.Tracker.GetJob(r.Context(), r.PathValue("jobId"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
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
	writeJSON(w, http.StatusOK, object)
	return nil
}

func (server *api) patchJob(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	write, _, err := readJobWrite(r)
	if err != nil {
		return err
	}
	job, err := server.deps.Tracker.PatchJob(r.Context(), actorOf(caller), r.PathValue("jobId"), write)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, jobJSON(job))
	return nil
}

func (server *api) upsertJob(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	write, _, err := readJobWrite(r)
	if err != nil {
		return err
	}
	job, _, err := server.deps.Tracker.UpsertJob(r.Context(), actorOf(caller), r.PathValue("jobId"), write)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, jobJSON(job))
	return nil
}

func (server *api) deleteJob(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if err := server.deps.Tracker.DeleteJob(r.Context(), actorOf(caller), r.PathValue("jobId")); err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

type eventInput struct {
	JobID  *string `json:"jobId"`
	Action string  `json:"action"`
	Detail string  `json:"detail"`
}

type createdBody struct {
	ID int64 `json:"id"`
}

func (server *api) logJobEvent(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input eventInput
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	event, err := server.deps.Tracker.LogEvent(r.Context(), actorOf(caller), r.PathValue("jobId"), input.Action, input.Detail)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, createdBody{ID: event.ID})
	return nil
}

func (server *api) logEvent(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input eventInput
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	jobID := ""
	if input.JobID != nil {
		jobID = *input.JobID
	}
	event, err := server.deps.Tracker.LogEvent(r.Context(), actorOf(caller), jobID, input.Action, input.Detail)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, createdBody{ID: event.ID})
	return nil
}

func (server *api) listEvents(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	limit := 200
	if text := r.URL.Query().Get("limit"); text != "" {
		parsed, err := strconv.Atoi(text)
		if err != nil || parsed < 1 || parsed > 1000 {
			return &domain.ValidationError{Field: "limit", Problem: "must be a whole number from 1 to 1000"}
		}
		limit = parsed
	}
	lines, err := server.deps.Tracker.ListEvents(r.Context(), limit)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	encoded := make([]eventJSON, 0, len(lines))
	for _, line := range lines {
		encoded = append(encoded, eventLineJSON(line))
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

func (server *api) saveContact(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	body, err := readBody(r, 1<<20)
	if err != nil {
		return err
	}
	contact, err := wire.DecodeContact(body)
	if err != nil {
		return err
	}
	job, err := server.deps.Tracker.SaveContact(r.Context(), actorOf(caller), r.PathValue("jobId"), contact)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, jobJSON(job))
	return nil
}

func (server *api) uploadFile(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	query := r.URL.Query()
	file, err := server.deps.Attachments.Upload(r.Context(), caller.Actor(), r.PathValue("jobId"), query.Get("name"), query.Get("kind"), r.Header.Get("Content-Type"), r.Body)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusCreated, fileToJSON(file))
	return nil
}

// inlineSafe are the types a browser may show in place; anything else downloads.
var inlineSafe = map[string]bool{"application/pdf": true, "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "text/plain": true}

func (server *api) getFile(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	record, reader, err := server.deps.Attachments.Open(r.Context(), r.PathValue("fileId"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	defer func() { _ = reader.Close() }()
	mime := strings.ToLower(strings.TrimSpace(strings.Split(record.Mime, ";")[0]))
	header := w.Header()
	// Untrusted bytes: HTML is served as text, nothing runs, and only plain types show inline.
	header.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	switch {
	case mime == "text/html" || strings.HasSuffix(mime, "+xml") || strings.Contains(mime, "javascript") || mime == "image/svg+xml":
		header.Set("Content-Type", "text/plain; charset=utf-8")
	case inlineSafe[mime]:
		header.Set("Content-Type", mime)
	default:
		header.Set("Content-Type", "application/octet-stream")
	}
	disposition := "attachment"
	if inlineSafe[mime] {
		disposition = "inline"
	}
	header.Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, record.Name))
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, reader); err != nil && !errors.Is(err, io.EOF) {
		return nil // the client went away mid-download; nothing to tell it
	}
	return nil
}

func (server *api) deleteFile(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if err := server.deps.Attachments.Delete(r.Context(), caller.Actor(), r.PathValue("fileId")); err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}
