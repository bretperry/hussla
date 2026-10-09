// The MCP tests' rig: the real HTTP router and the real MCP handler over one in-memory store, and a small MCP client.
// In the app: nothing at runtime (tests only).
// Used by: every _test.go in this package.
// Uses: httpapi.New and mcpapi.New (mounted the way cmd/hussla mounts them), the use-cases, internal/testsupport fakes.
//
// Requests go straight into the handlers (no socket). The client speaks both protocol eras the way a
// real one does: the older handshake (initialize, then calls) and the stateless one (per-request
// _meta and the mirrored headers). Fixtures are synthetic.

package mcpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/filestore"
	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
	"github.com/bretperry/hussla/internal/mcpapi"
	"github.com/bretperry/hussla/internal/testsupport/fakeauth"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

const (
	tailnetHost   = "hussla.tail0000.ts.net"
	tailnetOrigin = "https://" + tailnetHost
	localHost     = "localhost:8484"
	ownerAddr     = "100.64.0.1:40001"
	offAddr       = "127.0.0.1:50000"
)

var ownerPeer = auth.TailnetPeer{UserID: "1001", Login: "owner@example.com", Name: "Pat Owner"}

// rig is one install with both doors on both listeners.
type rig struct {
	t       *testing.T
	auth    *auth.Service
	owner   auth.Principal
	tailnet http.Handler // httpapi + mcpapi on the tailnet host, as cmd/hussla mounts them
	local   http.Handler // the same on the local listener
	signIn  *fakeauth.SignInTokens
	clock   *fakeauth.Clock
	deps    mcpapi.Deps // the use-cases behind both doors, for a test that builds its own door
}

func newRig(t *testing.T) *rig {
	t.Helper()
	store := fakes.New()
	peers := fakeauth.NewTailnet()
	peers.Add(ownerAddr, ownerPeer)
	clock := fakeauth.NewClock(time.Date(2026, 10, 8, 15, 0, 0, 0, time.UTC))
	signIn := &fakeauth.SignInTokens{}
	dir := t.TempDir()
	blobs, err := filestore.NewBlobs(filepath.Join(dir, "files"))
	if err != nil {
		t.Fatal(err)
	}
	resumes, err := filestore.NewResumes(filepath.Join(dir, "resumes"))
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		t.Fatal(err)
	}
	authService := auth.New(auth.Options{
		Store: store, Ceremony: passkey.Ceremony{}, SignIn: signIn, Now: clock.Now,
		AnnounceSetupCode: func(string) {}, RemindSetupCode: func(time.Time) {},
	})
	apiDeps := httpapi.Deps{
		Auth: authService, Tracker: tracker.New(store, clock.Now),
		Mail:        mailbox.New(mailbox.Options{Store: store, Location: location, Now: clock.Now}),
		Attachments: attachments.New(store, blobs, resumes, config.UploadMaxBytes, clock.Now),
		AgentsGuide: "# guide",
	}
	mcpDeps := mcpapi.Deps{Auth: apiDeps.Auth, Tracker: apiDeps.Tracker, Mail: apiDeps.Mail}
	mount := func(api, mcp http.Handler) http.Handler {
		mux := http.NewServeMux()
		mux.Handle(config.MCPPath, mcp)
		mux.Handle("/", api)
		return mux
	}
	localHosts := []string{localHost, "127.0.0.1:8484"}
	r := &rig{
		t: t, auth: authService, signIn: signIn, clock: clock, deps: mcpDeps,
		tailnet: mount(
			httpapi.New(httpapi.Config{Listener: httpapi.ListenerTailnet, Hosts: []string{tailnetHost}, Peers: peers}, apiDeps),
			mcpapi.New(mcpapi.Config{Hosts: []string{tailnetHost}, Secure: true}, mcpDeps)),
		local: mount(
			httpapi.New(httpapi.Config{Listener: httpapi.ListenerLocal, Hosts: localHosts}, apiDeps),
			mcpapi.New(mcpapi.Config{Hosts: localHosts}, mcpDeps)),
	}
	ctx := context.Background()
	if _, err := authService.AdoptNodeOwner(ctx, ownerPeer); err != nil {
		t.Fatal(err)
	}
	r.owner, err = authService.TailnetPrincipal(ctx, ownerPeer)
	if err != nil || !r.owner.IsOwner() {
		t.Fatalf("owner principal: %v %v", r.owner, err)
	}
	return r
}

// key makes an agent key and returns its id and secret.
func (r *rig) key(name string) (id, secret string) {
	r.t.Helper()
	token, secret, err := r.auth.CreateKey(context.Background(), r.owner, name)
	if err != nil {
		r.t.Fatal(err)
	}
	return token.ID, secret
}

// reply is one HTTP answer.
type reply struct {
	status int
	header http.Header
	body   []byte
}

func (rep reply) object(t *testing.T) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(rep.body, &decoded); err != nil {
		t.Fatalf("not a JSON object (%d): %s", rep.status, rep.body)
	}
	return decoded
}

// request is one raw HTTP request to a handler.
type request struct {
	method  string
	path    string
	body    any // marshaled unless string or []byte
	host    string
	from    string
	local   bool
	headers map[string]string
}

func (r *rig) do(q request) reply {
	r.t.Helper()
	if q.method == "" {
		q.method = http.MethodPost
	}
	var body io.Reader
	switch value := q.body.(type) {
	case nil:
	case []byte:
		body = bytes.NewReader(value)
	case string:
		body = strings.NewReader(value)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			r.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(q.method, q.path, body)
	handler := r.tailnet
	req.Host, req.RemoteAddr = tailnetHost, offAddr
	if q.local {
		handler = r.local
		req.Host = localHost
	}
	if q.host != "" {
		req.Host = q.host
	}
	if q.from != "" {
		req.RemoteAddr = q.from
	}
	if q.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range q.headers {
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	result := recorder.Result()
	defer func() { _ = result.Body.Close() }()
	raw, _ := io.ReadAll(result.Body)
	return reply{status: result.StatusCode, header: result.Header, body: raw}
}

// httpAsAgent calls the HTTP API with an agent key.
func (r *rig) httpAsAgent(secret, method, path string, body any) reply {
	r.t.Helper()
	return r.do(request{method: method, path: path, body: body, headers: map[string]string{"Authorization": "Bearer " + secret}})
}

// httpAsOwner is a write or read from the owner's browser on the tailnet.
func (r *rig) httpAsOwner(method, path string, body any) reply {
	r.t.Helper()
	return r.do(request{method: method, path: path, body: body, from: ownerAddr, headers: map[string]string{"Origin": tailnetOrigin}})
}

// ---- the MCP client

type era int

const (
	eraLegacy era = iota // initialize, then calls (2025-11-25)
	eraModern            // stateless: _meta and mirrored headers (2026-07-28)
)

func (e era) String() string {
	if e == eraModern {
		return "modern"
	}
	return "legacy"
}

// client is an MCP client of one era holding one agent key.
type client struct {
	r      *rig
	t      *testing.T
	secret string
	era    era
	nextID int
	called map[string]bool // tools called through this client
}

// connect makes a client and, for the legacy era, runs the handshake a real client does.
func (r *rig) connect(secret string, e era) *client {
	r.t.Helper()
	c := &client{r: r, t: r.t, secret: secret, era: e, called: map[string]bool{}}
	if e == eraLegacy {
		init := c.rpc("initialize", map[string]any{
			"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "0"},
		})
		if init.status != http.StatusOK || init.result()["protocolVersion"] != "2025-11-25" {
			r.t.Fatalf("initialize: %d %s", init.status, init.body)
		}
		if got := init.header.Get("Mcp-Session-Id"); got != "" {
			r.t.Fatalf("a session id was minted: %q", got)
		}
		note := c.post(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, nil)
		if note.status != http.StatusAccepted || len(note.body) != 0 {
			r.t.Fatalf("initialized notification: %d %q", note.status, note.body)
		}
	}
	return c
}

// post sends one JSON-RPC message with the client's key and any extra headers.
func (c *client) post(message map[string]any, extra map[string]string) reply {
	c.t.Helper()
	headers := map[string]string{"Authorization": "Bearer " + c.secret, "Accept": "application/json, text/event-stream"}
	for name, value := range extra {
		headers[name] = value
	}
	return c.r.do(request{path: "/mcp", body: message, headers: headers})
}

// rpcResult is a decoded answer to one request.
type rpcResult struct {
	status int
	header http.Header
	body   []byte
	Result map[string]any `json:"result"`
	Error  *struct {
		Code    int            `json:"code"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	} `json:"error"`
}

// modernMeta is the per-request metadata every 2026-07-28 request carries.
func modernMeta() map[string]any {
	return map[string]any{
		"io.modelcontextprotocol/protocolVersion":    "2026-07-28",
		"io.modelcontextprotocol/clientInfo":         map[string]any{"name": "test", "version": "0"},
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	}
}

// rpc sends one request in the client's era and decodes the answer.
func (c *client) rpc(method string, params map[string]any) rpcResult {
	c.t.Helper()
	c.nextID++
	message := map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method}
	headers := map[string]string{}
	if c.era == eraModern && method != "initialize" {
		if params == nil {
			params = map[string]any{}
		}
		params["_meta"] = modernMeta()
		headers["MCP-Protocol-Version"] = "2026-07-28"
		headers["Mcp-Method"] = method
		if name, ok := params["name"].(string); ok && method == "tools/call" {
			headers["Mcp-Name"] = name
		}
	} else if c.era == eraLegacy && method != "initialize" {
		headers["MCP-Protocol-Version"] = "2025-11-25"
	}
	if params != nil {
		message["params"] = params
	}
	return decodeRPC(c.t, c.post(message, headers))
}

func decodeRPC(t *testing.T, rep reply) rpcResult {
	t.Helper()
	var decoded rpcResult
	if len(rep.body) > 0 {
		if err := json.Unmarshal(rep.body, &decoded); err != nil {
			t.Fatalf("not JSON-RPC (%d): %s", rep.status, rep.body)
		}
	}
	decoded.status, decoded.header, decoded.body = rep.status, rep.header, rep.body
	return decoded
}

func (rep rpcResult) result() map[string]any { return rep.Result }

// toolOutcome is a decoded tools/call result.
type toolOutcome struct {
	isError bool
	text    string
}

// json decodes the text content as a JSON object.
func (o toolOutcome) json(t *testing.T) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(o.text), &decoded); err != nil {
		t.Fatalf("tool text is not a JSON object: %s", o.text)
	}
	return decoded
}

// call runs a tool and returns its outcome; the call itself must succeed as JSON-RPC.
func (c *client) call(name string, args map[string]any) toolOutcome {
	c.t.Helper()
	c.called[name] = true
	answer := c.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	return c.outcome(answer)
}

func (c *client) outcome(answer rpcResult) toolOutcome {
	c.t.Helper()
	if answer.status != http.StatusOK || answer.Error != nil {
		c.t.Fatalf("tools/call: %d %s", answer.status, answer.body)
	}
	content, _ := answer.Result["content"].([]any)
	if len(content) != 1 {
		c.t.Fatalf("tools/call content: %s", answer.body)
	}
	block, _ := content[0].(map[string]any)
	text, _ := block["text"].(string)
	isError, _ := answer.Result["isError"].(bool)
	if c.era == eraModern && answer.Result["resultType"] != "complete" {
		c.t.Fatalf("modern result lacks resultType: %s", answer.body)
	}
	return toolOutcome{isError: isError, text: text}
}

// ok runs a tool that must succeed and returns its JSON object.
func (c *client) ok(name string, args map[string]any) map[string]any {
	c.t.Helper()
	outcome := c.call(name, args)
	if outcome.isError {
		c.t.Fatalf("%s failed: %s", name, outcome.text)
	}
	return outcome.json(c.t)
}

// refused runs a tool that must come back as isError and returns its message.
func (c *client) refused(name string, args map[string]any) string {
	c.t.Helper()
	outcome := c.call(name, args)
	if !outcome.isError {
		c.t.Fatalf("%s should have been refused, got: %s", name, outcome.text)
	}
	return outcome.text
}

// toolNames is tools/list as names, in order.
func (c *client) toolNames() []string {
	c.t.Helper()
	answer := c.rpc("tools/list", nil)
	list, _ := answer.Result["tools"].([]any)
	names := make([]string, 0, len(list))
	for _, entry := range list {
		item, _ := entry.(map[string]any)
		name, _ := item["name"].(string)
		names = append(names, name)
	}
	return names
}

// forEachEra runs a test body once per protocol era with a fresh install.
func forEachEra(t *testing.T, body func(t *testing.T, r *rig, c *client)) {
	t.Helper()
	for _, e := range []era{eraLegacy, eraModern} {
		t.Run(e.String(), func(t *testing.T) {
			r := newRig(t)
			_, secret := r.key("laptop")
			body(t, r, r.connect(secret, e))
		})
	}
}
