// Meta, answers, settings, résumés, backup, agent keys and the web app.
// In the app: GET /api and /api/docs for agents, the Answers page, Settings, the dashboard counts, the SPA shell.
// Used by: server.go's route table.

package httpapi

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

func (server *api) apiIndex(w http.ResponseWriter, _ *http.Request, _ auth.Principal) error {
	writeJSON(w, http.StatusOK, map[string]any{
		"name": config.ProductName, "docs": "/api/docs", "statuses": config.JobStatusOrder, "endpoints": server.endpoints,
	})
	return nil
}

func (server *api) apiDocs(w http.ResponseWriter, _ *http.Request, _ auth.Principal) error {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, server.deps.AgentsGuide)
	return nil
}

func (server *api) me(w http.ResponseWriter, _ *http.Request, caller auth.Principal) error {
	body := map[string]any{"kind": "agent", "name": caller.Name(), "appName": config.ProductName}
	if caller.IsOwner() {
		body["kind"] = "user"
		if caller.Login() != "" {
			body["login"] = caller.Login()
		}
	}
	writeJSON(w, http.StatusOK, body)
	return nil
}

func (server *api) stats(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	stats, err := server.deps.Tracker.Stats(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	byStatus := map[string]int{}
	for status, count := range stats.ByStatus {
		byStatus[status.String()] = count
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": stats.Total, "byStatus": byStatus, "unanswered": stats.Unanswered, "drafts": stats.Drafts})
	return nil
}

func (server *api) listAnswers(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	list, err := server.deps.Tracker.ListAnswers(r.Context())
	if err != nil {
		return err
	}
	encoded := make([]wire.Object, 0, len(list))
	for _, answer := range list {
		encoded = append(encoded, answerJSON(answer))
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

func (server *api) writeAnswer(w http.ResponseWriter, r *http.Request, caller auth.Principal, id string, status int) error {
	object, err := readObject(r)
	if err != nil {
		return err
	}
	if id == "" {
		if value, present := object["id"]; present {
			text, ok := wire.Text(value)
			if !ok || !domain.IsValidRecordID(text) {
				return &domain.ValidationError{Field: "id", Problem: "must be 1-120 lowercase letters, digits and hyphens"}
			}
			id = text
		}
	}
	decoder := &wire.Decoder{}
	patch, err := decoder.DecodeAnswerPatch(object)
	if err != nil {
		return err
	}
	answer, _, err := server.deps.Tracker.SaveAnswer(r.Context(), actorOf(caller), id, patch)
	if err != nil {
		return err
	}
	writeJSON(w, status, answerJSON(answer))
	return nil
}

func (server *api) saveAnswer(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	return server.writeAnswer(w, r, caller, "", http.StatusCreated)
}

func (server *api) patchAnswer(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	return server.writeAnswer(w, r, caller, r.PathValue("answerId"), http.StatusOK)
}

func (server *api) deleteAnswer(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	found, err := server.deps.Tracker.DeleteAnswer(r.Context(), actorOf(caller), r.PathValue("answerId"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: found})
	return nil
}

func (server *api) getConfig(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	object, err := server.deps.Tracker.SearchConfig(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, object)
	return nil
}

func (server *api) patchConfig(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	object, err := readObject(r)
	if err != nil {
		return err
	}
	merged, err := server.deps.Tracker.PatchSearchConfig(r.Context(), actorOf(caller), object)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, merged)
	return nil
}

func (server *api) listResumes(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	list, err := server.deps.Attachments.ListResumes(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	encoded := make([]map[string]any, 0, len(list))
	for _, resume := range list {
		encoded = append(encoded, resumeJSON(resume))
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

func (server *api) getResume(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	name := r.PathValue("name")
	reader, err := server.deps.Attachments.OpenResume(r.Context(), name)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	defer func() { _ = reader.Close() }()
	contentType := "application/octet-stream"
	if strings.EqualFold(path.Ext(name), ".pdf") {
		contentType = "application/pdf"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
	return nil
}

func (server *api) export(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	bundle, err := server.deps.Tracker.ExportAll(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	jobs := make([]wire.Object, 0, len(bundle.Jobs))
	for _, job := range bundle.Jobs {
		jobs = append(jobs, wire.JobObject(job))
	}
	companies := make([]wire.Object, 0, len(bundle.Companies))
	for _, company := range bundle.Companies {
		companies = append(companies, wire.CompanyObject(company))
	}
	answers := make([]wire.Object, 0, len(bundle.Answers))
	for _, answer := range bundle.Answers {
		answers = append(answers, wire.AnswerObject(answer))
	}
	events := make([]eventJSON, 0, len(bundle.Events))
	for _, event := range bundle.Events {
		events = append(events, eventToJSON(event))
	}
	w.Header().Set("Content-Disposition", `attachment; filename="hussla-export.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"exportedAt": domain.FormatTimestamp(time.Now()), "config": bundle.Config,
		"jobs": jobs, "companies": companies, "answers": answers, "events": events,
	})
	return nil
}

func (server *api) importBundle(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	body, err := readBody(r, config.RequestBodyMaxBytes)
	if err != nil {
		return err
	}
	report, err := server.deps.Tracker.Import(r.Context(), actorOf(caller), body)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jobs": report.Jobs.Created, "companies": report.Companies.Created, "answers": report.Answers.Created, "events": report.Events.Created,
	})
	return nil
}

func (server *api) listKeys(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	list, err := server.deps.Auth.ListKeys(r.Context(), caller)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	encoded := make([]agentKeyJSON, 0, len(list))
	for _, token := range list {
		encoded = append(encoded, agentKeyToJSON(token))
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

func (server *api) createKey(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	token, secret, err := server.deps.Auth.CreateKey(r.Context(), caller, input.Name)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]string{"id": token.ID, "name": token.Name, "token": secret})
	return nil
}

func (server *api) revokeKey(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	changed, err := server.deps.Auth.RevokeKey(r.Context(), caller, r.PathValue("keyId"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: changed})
	return nil
}

// placeholderPage is served until the web app is built into the binary (Phases 5-6).
const placeholderPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hussla</title></head><body><h1>Hussla</h1><p>The server is running. The web app isn't built into this binary yet; the API is at <a href="/api">/api</a>.</p></body></html>`

// serveUI serves the web app: a file when one matches, index.html otherwise (client-side routes).
func (server *api) serveUI(w http.ResponseWriter, r *http.Request) {
	if server.deps.UI == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, placeholderPage)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fs.Stat(server.deps.UI, name); err != nil {
		name = "index.html"
	}
	http.ServeFileFS(w, r, server.deps.UI, name)
}
