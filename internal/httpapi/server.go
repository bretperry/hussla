// The HTTP API: one handler per listener (the tailnet's HTTPS, or the local http://localhost), with the routes of api/openapi.yaml.
// In the app: everything the UI and every agent does goes through here.
// Used by: cmd/hussla (one handler per listener); the route and auth-matrix tests (through New, with fakes).
// Uses: the use-cases in internal/app only (depguard keeps adapters out), guard.go for who may do what.
//
// The two listeners differ only in where identity comes from: the tailnet listener asks WhoIs about
// the connection and ignores cookies; the local listener reads its own session cookie and never
// asks the tailnet. Neither reads an identity header. Agent bearer keys work on both.

package httpapi

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/app/tracker"
)

// Listener says which door a handler serves.
type Listener int

const (
	// ListenerTailnet: HTTPS on the tailnet; identity from WhoIs.
	ListenerTailnet Listener = iota
	// ListenerLocal: http://localhost on this computer; identity from the session cookie `hussla open` starts.
	ListenerLocal
)

// SessionCookie is the local listener's session cookie (HttpOnly, SameSite=Strict).
const SessionCookie = "hussla_session"

// StepUpHeader carries the one-action token from a passkey tap on owner-only requests.
const StepUpHeader = "X-Hussla-Step-Up"

// Config is one listener's door.
type Config struct {
	Listener Listener
	// Hosts are the exact Host values this listener answers ("hussla.tail1234.ts.net",
	// "localhost:8484"). Anything else is refused before identity is even looked at.
	Hosts []string
	// Peers answers WhoIs on the tailnet listener; nil on the local listener.
	Peers auth.PeerIdentifier
	// PlainHTTP serves the tailnet door over http (Origin http://<host>, no HSTS). Only the
	// end-to-end test build sets it, for its fake tailnet on localhost; the real tailnet is HTTPS.
	PlainHTTP bool
}

// Deps are the use-cases.
type Deps struct {
	Auth        *auth.Service
	Tracker     *tracker.Service
	Mail        *mailbox.Service
	Attachments *attachments.Service
	// Setup is the first run (home-network page, wizard, key expiry); nil serves those routes as off.
	Setup *setup.Service
	// MailSetup saves and shows the mail provider setup; nil answers its routes "not set up".
	MailSetup *mailsetup.Service
	// AgentsGuide is docs/agents-api.md, served at /api/docs.
	AgentsGuide string
	// UI is the built web app (index.html at its root); nil serves a placeholder page.
	UI fs.FS
}

type api struct {
	config Config
	deps   Deps
	hosts  map[string]bool
	mux    *http.ServeMux
	scheme string
	// endpoints lists every API route, in registration order, for GET /api.
	endpoints []string
}

// New builds one listener's handler.
func New(config Config, deps Deps) http.Handler {
	server := &api{config: config, deps: deps, hosts: map[string]bool{}, mux: http.NewServeMux(), scheme: "https"}
	if config.Listener == ListenerLocal || config.PlainHTTP {
		server.scheme = "http"
	}
	for _, host := range config.Hosts {
		server.hosts[strings.ToLower(host)] = true
	}
	server.routes()
	return server
}

// handle registers a route and, when it is an API route, lists it for GET /api.
func (server *api) handle(pattern string, handler http.Handler) {
	server.mux.Handle(pattern, handler)
	if method, path, found := strings.Cut(pattern, " "); found && strings.HasPrefix(path, "/api") {
		server.endpoints = append(server.endpoints, method+" "+path)
	}
}

func (server *api) routes() {
	// meta
	server.handle("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, okBody{OK: true}) }))
	server.handle("GET /api", server.member(server.apiIndex))
	server.handle("GET /api/docs", server.member(server.apiDocs))
	server.handle("GET /api/me", server.member(server.me))
	server.handle("GET /api/stats", server.member(server.stats))
	// setup and passkeys
	server.handle("GET /api/setup", server.anyone(server.setupStatus))
	server.handle("POST /api/setup/claim", server.anyone(server.setupClaim))
	server.handle("GET /signin", server.anyone(server.signIn))
	server.handle("POST /api/setup/code", server.anyone(server.setupNewCode))
	server.handle("PATCH /api/setup/wizard", server.owner(server.markWizardStep))
	server.handle("GET /api/setup/qr", server.owner(server.addressQR))
	server.handle("GET /api/passkeys", server.owner(server.listPasskeys))
	server.handle("DELETE /api/passkeys/{passkeyId}", server.ownerStepUp(server.removePasskey))
	server.handle("POST /api/passkeys/register/begin", server.ownerStepUp(server.registerBegin))
	server.handle("POST /api/passkeys/register/finish", server.owner(server.registerFinish))
	server.handle("POST /api/stepup/begin", server.owner(server.stepUpBegin))
	server.handle("POST /api/stepup/finish", server.owner(server.stepUpFinish))
	server.handle("POST /api/sessions/revoke-all", server.ownerStepUp(server.signOutEverywhere))
	// jobs
	server.handle("GET /api/jobs", server.member(server.listJobs))
	server.handle("POST /api/jobs", server.member(server.createJob))
	server.handle("GET /api/jobs/{jobId}", server.member(server.getJob))
	server.handle("PATCH /api/jobs/{jobId}", server.member(server.patchJob))
	server.handle("PUT /api/jobs/{jobId}", server.member(server.upsertJob))
	server.handle("DELETE /api/jobs/{jobId}", server.ownerStepUp(server.deleteJob))
	server.handle("POST /api/jobs/{jobId}/events", server.member(server.logJobEvent))
	server.handle("POST /api/jobs/{jobId}/contacts", server.member(server.saveContact))
	server.handle("POST /api/jobs/{jobId}/files", server.member(server.uploadFile))
	server.handle("POST /api/jobs/{jobId}/emails", server.member(server.draftJobEmail))
	server.handle("GET /api/files/{fileId}", server.member(server.getFile))
	server.handle("DELETE /api/files/{fileId}", server.ownerStepUp(server.deleteFile))
	// companies
	server.handle("GET /api/companies", server.member(server.listCompanies))
	server.handle("GET /api/companies/{slug}", server.member(server.getCompany))
	server.handle("PATCH /api/companies/{slug}", server.member(server.patchCompany))
	server.handle("POST /api/companies/{slug}/news", server.member(server.addNews))
	server.handle("POST /api/companies/{slug}/reviews", server.member(server.saveReview))
	server.handle("POST /api/companies/{slug}/emails", server.member(server.draftCompanyEmail))
	// activity, answers, settings
	server.handle("GET /api/events", server.member(server.listEvents))
	server.handle("POST /api/events", server.member(server.logEvent))
	server.handle("GET /api/answers", server.member(server.listAnswers))
	server.handle("POST /api/answers", server.member(server.saveAnswer))
	server.handle("PATCH /api/answers/{answerId}", server.member(server.patchAnswer))
	server.handle("DELETE /api/answers/{answerId}", server.ownerStepUp(server.deleteAnswer))
	// pitches: agents read and add versions; the owner starts, edits, picks the live one and deletes
	server.handle("GET /api/pitches", server.member(server.listPitches))
	server.handle("POST /api/pitches", server.owner(server.createPitch))
	server.handle("PATCH /api/pitches/{slot}", server.owner(server.patchPitch))
	server.handle("DELETE /api/pitches/{slot}", server.ownerStepUp(server.deletePitch))
	server.handle("POST /api/pitches/{slot}/versions", server.member(server.addPitchVersion))
	server.handle("DELETE /api/pitches/{slot}/versions/{version}", server.ownerStepUp(server.deletePitchVersion))
	server.handle("POST /api/pitches/{slot}/live", server.ownerStepUp(server.setLivePitch))
	server.handle("GET /api/config", server.member(server.getConfig))
	server.handle("PATCH /api/config", server.ownerStepUp(server.patchConfig))
	server.handle("GET /api/resumes", server.member(server.listResumes))
	server.handle("GET /resumes/{name}", server.member(server.getResume))
	server.handle("GET /api/export", server.member(server.export))
	server.handle("POST /api/import", server.ownerStepUp(server.importBundle))
	// agent keys
	server.handle("GET /api/tokens", server.owner(server.listKeys))
	server.handle("POST /api/tokens", server.ownerStepUp(server.createKey))
	server.handle("DELETE /api/tokens/{keyId}", server.ownerStepUp(server.revokeKey))
	// mail
	server.handle("GET /api/mail", server.member(server.mailStatus))
	server.handle("GET /api/mail/providers", server.owner(server.mailProviders))
	server.handle("GET /api/mail/settings", server.owner(server.mailSettings))
	server.handle("PUT /api/mail/settings", server.ownerStepUp(server.saveMailSettings))
	server.handle("POST /api/mail/test", server.ownerStepUp(server.sendTest))
	server.handle("GET /api/emails", server.member(server.listEmails))
	server.handle("PATCH /api/emails/{emailId}", server.member(server.editEmail))
	server.handle("POST /api/emails/{emailId}/approve", server.ownerStepUp(server.approveEmail))
	server.handle("POST /api/emails/{emailId}/cancel", server.member(server.cancelEmail))
	// anything else under /api is a 404 in JSON; the rest is the web app
	server.handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, errorBody{Error: "no such endpoint; GET /api lists them"})
	}))
	server.handle("/", http.HandlerFunc(server.serveUI)) // GET and HEAD only; serveUI refuses the rest
}

type okBody struct {
	OK bool `json:"ok"`
}
