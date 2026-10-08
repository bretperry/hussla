// The /mcp door: what is refused, and the rule that no tool reaches an owner-only action.
// In the app: nothing at runtime (tests only).
// Used by: go test ./internal/mcpapi/...
// Uses: the rig and client in harness_test.go, the real HTTP router for the owner-only comparison.
//
// Like the HTTP auth matrix, every refusal row is proved by what it lacks: a row passes only when
// the request is refused, so a check removed from the door turns its row red.

package mcpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/mcpapi"
)

var ping = map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}

func bearer(secret string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + secret}
}

func TestDoorRefusals(t *testing.T) {
	r := newRig(t)
	keyID, secret := r.key("laptop")
	oldID, revokedSecret := r.key("old")
	if _, err := r.auth.RevokeKey(context.Background(), r.owner, oldID); err != nil {
		t.Fatal(err)
	}

	// A real local session: what `hussla open` would have set.
	r.signIn.Put("local-token", r.clock.Now().Add(config.SignInTokenLifetime))
	token, _ := r.signIn.Read(context.Background())
	signedIn := r.do(request{method: http.MethodGet, path: "/signin?t=" + token.Secret, local: true})
	var session string
	for _, cookie := range (&http.Response{Header: signedIn.header}).Cookies() {
		session = cookie.Name + "=" + cookie.Value
	}
	if session == "" {
		t.Fatalf("no local session: %d %s", signedIn.status, signedIn.body)
	}

	rows := []struct {
		name string
		req  request
		want int
	}{
		{"no credentials", request{path: "/mcp", body: ping}, http.StatusUnauthorized},
		{"the owner's tailnet identity, no key", request{path: "/mcp", body: ping, from: ownerAddr}, http.StatusUnauthorized},
		{"the owner's identity with the right Origin, no key", request{path: "/mcp", body: ping, from: ownerAddr, headers: map[string]string{"Origin": tailnetOrigin}}, http.StatusUnauthorized},
		{"a Tailscale identity header from loopback", request{path: "/mcp", body: ping, headers: map[string]string{"Tailscale-User-Login": "owner@example.com", "Tailscale-User-Name": "Pat Owner"}}, http.StatusUnauthorized},
		{"a signed-in local session cookie", request{path: "/mcp", body: ping, local: true, headers: map[string]string{"Cookie": session}}, http.StatusUnauthorized},
		{"a key sent as a cookie", request{path: "/mcp", body: ping, headers: map[string]string{"Cookie": "hussla_session=" + secret}}, http.StatusUnauthorized},
		{"Basic auth with the key", request{path: "/mcp", body: ping, headers: map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("agent:"+secret))}}, http.StatusUnauthorized},
		{"a key in the query string", request{path: "/mcp?access_token=" + secret, body: ping}, http.StatusUnauthorized},
		{"a key that was never made", request{path: "/mcp", body: ping, headers: bearer(auth.AgentKeyPrefix + "nope")}, http.StatusUnauthorized},
		{"a bearer that isn't a key", request{path: "/mcp", body: ping, headers: bearer("nonsense")}, http.StatusUnauthorized},
		{"an empty bearer", request{path: "/mcp", body: ping, headers: map[string]string{"Authorization": "Bearer "}}, http.StatusUnauthorized},
		{"a revoked key", request{path: "/mcp", body: ping, headers: bearer(revokedSecret)}, http.StatusUnauthorized},
		{"a good key, wrong Host", request{path: "/mcp", body: ping, host: "evil.example", headers: bearer(secret)}, http.StatusMisdirectedRequest},
		{"a good key, foreign Origin", request{path: "/mcp", body: ping, headers: map[string]string{"Authorization": "Bearer " + secret, "Origin": "https://evil.example"}}, http.StatusForbidden},
		{"a good key, the local Origin on the tailnet listener", request{path: "/mcp", body: ping, headers: map[string]string{"Authorization": "Bearer " + secret, "Origin": "http://" + localHost}}, http.StatusForbidden},
		{"GET (no server stream)", request{method: http.MethodGet, path: "/mcp", headers: bearer(secret)}, http.StatusMethodNotAllowed},
		{"DELETE (no sessions)", request{method: http.MethodDelete, path: "/mcp", headers: bearer(secret)}, http.StatusMethodNotAllowed},
		{"PUT", request{method: http.MethodPut, path: "/mcp", body: ping, headers: bearer(secret)}, http.StatusMethodNotAllowed},
		{"an empty body", request{path: "/mcp", body: "", headers: bearer(secret)}, http.StatusBadRequest},
		{"not JSON", request{path: "/mcp", body: "hello", headers: bearer(secret)}, http.StatusBadRequest},
		{"a batch", request{path: "/mcp", body: []map[string]any{ping, ping}, headers: bearer(secret)}, http.StatusBadRequest},
		{"not JSON-RPC 2.0", request{path: "/mcp", body: map[string]any{"id": 1, "method": "ping"}, headers: bearer(secret)}, http.StatusBadRequest},
		{"a null id", request{path: "/mcp", body: `{"jsonrpc":"2.0","id":null,"method":"ping"}`, headers: bearer(secret)}, http.StatusBadRequest},
		{"a body over the limit", request{path: "/mcp", body: bytes.Repeat([]byte("x"), config.RequestBodyMaxBytes+1), headers: bearer(secret)}, http.StatusRequestEntityTooLarge},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			got := r.do(row.req)
			if got.status != row.want {
				t.Fatalf("status %d, want %d: %s", got.status, row.want, got.body)
			}
			if row.want == http.StatusUnauthorized && !strings.HasPrefix(got.header.Get("WWW-Authenticate"), "Bearer") {
				t.Errorf("a 401 should say Bearer: %q", got.header.Get("WWW-Authenticate"))
			}
			if row.want == http.StatusMethodNotAllowed && got.header.Get("Allow") != http.MethodPost {
				t.Errorf("a 405 should say Allow: POST, got %q", got.header.Get("Allow"))
			}
			if strings.Contains(string(got.body), secret) {
				t.Errorf("the key came back in the response: %s", got.body)
			}
		})
	}

	// What does work: the key on either listener, with no Origin or the listener's own.
	for name, req := range map[string]request{
		"tailnet, no Origin":          {path: "/mcp", body: ping, headers: bearer(secret)},
		"tailnet, own Origin":         {path: "/mcp", body: ping, headers: map[string]string{"Authorization": "Bearer " + secret, "Origin": tailnetOrigin}},
		"local":                       {path: "/mcp", body: ping, local: true, headers: bearer(secret)},
		"from the owner's own laptop": {path: "/mcp", body: ping, from: ownerAddr, headers: bearer(secret)},
	} {
		if got := r.do(req); got.status != http.StatusOK {
			t.Errorf("%s: status %d: %s", name, got.status, got.body)
		}
	}

	// Revoking a key closes it straight away.
	if got := r.do(request{path: "/mcp", body: ping, headers: bearer(secret)}); got.status != http.StatusOK {
		t.Fatalf("before revoking: %d", got.status)
	}
	if _, err := r.auth.RevokeKey(context.Background(), r.owner, keyID); err != nil {
		t.Fatal(err)
	}
	if got := r.do(request{path: "/mcp", body: ping, headers: bearer(secret)}); got.status != http.StatusUnauthorized {
		t.Errorf("after revoking: %d", got.status)
	}
}

func TestModernEnvelope(t *testing.T) {
	r := newRig(t)
	_, secret := r.key("laptop")
	call := func(headers map[string]string, params map[string]any) rpcResult {
		t.Helper()
		merged := bearer(secret)
		for name, value := range headers {
			merged[name] = value
		}
		return decodeRPC(t, r.do(request{path: "/mcp", headers: merged, body: map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": params}}))
	}
	good := func() map[string]any {
		return map[string]any{"name": "list_answers", "arguments": map[string]any{}, "_meta": modernMeta()}
	}
	headers := func(mutate func(map[string]string)) map[string]string {
		h := map[string]string{"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "list_answers"}
		if mutate != nil {
			mutate(h)
		}
		return h
	}
	meta := func(mutate func(map[string]any)) map[string]any {
		params := good()
		m := modernMeta()
		mutate(m)
		params["_meta"] = m
		return params
	}

	if got := call(headers(nil), good()); got.status != http.StatusOK || got.Error != nil {
		t.Fatalf("the good request: %d %s", got.status, got.body)
	}
	encoded := "=?base64?" + base64.StdEncoding.EncodeToString([]byte("list_answers")) + "?="
	if got := call(headers(func(h map[string]string) { h["Mcp-Name"] = encoded }), good()); got.status != http.StatusOK {
		t.Errorf("a base64 Mcp-Name: %d %s", got.status, got.body)
	}

	rows := []struct {
		name    string
		headers map[string]string
		params  map[string]any
		status  int
		code    int
	}{
		{"no version header", headers(func(h map[string]string) { delete(h, "MCP-Protocol-Version") }), good(), 400, -32020},
		{"version header differs from _meta", headers(func(h map[string]string) { h["MCP-Protocol-Version"] = "2025-11-25" }), good(), 400, -32020},
		{"no Mcp-Method", headers(func(h map[string]string) { delete(h, "Mcp-Method") }), good(), 400, -32020},
		{"Mcp-Method differs from the body", headers(func(h map[string]string) { h["Mcp-Method"] = "tools/list" }), good(), 400, -32020},
		{"no Mcp-Name on tools/call", headers(func(h map[string]string) { delete(h, "Mcp-Name") }), good(), 400, -32020},
		{"Mcp-Name differs from params.name", headers(func(h map[string]string) { h["Mcp-Name"] = "get_job" }), good(), 400, -32020},
		{"an unknown version in _meta and header", headers(func(h map[string]string) { h["MCP-Protocol-Version"] = "1900-01-01" }), meta(func(m map[string]any) { m["io.modelcontextprotocol/protocolVersion"] = "1900-01-01" }), 400, -32022},
		{"no client capabilities", headers(nil), meta(func(m map[string]any) { delete(m, "io.modelcontextprotocol/clientCapabilities") }), 400, -32602},
		{"the modern header without _meta", headers(nil), map[string]any{"name": "list_answers", "arguments": map[string]any{}}, 400, -32602},
		{"an unknown version header without _meta", map[string]string{"MCP-Protocol-Version": "1900-01-01"}, map[string]any{"name": "list_answers", "arguments": map[string]any{}}, 400, -32022},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			got := call(row.headers, row.params)
			if got.status != row.status || got.Error == nil || got.Error.Code != row.code {
				t.Fatalf("got %d %s, want %d / %d", got.status, got.body, row.status, row.code)
			}
			if row.code == -32022 {
				supported, _ := got.Error.Data["supported"].([]any)
				if len(supported) == 0 || supported[0] != "2026-07-28" || got.Error.Data["requested"] != "1900-01-01" {
					t.Errorf("an unsupported version should list what is supported: %s", got.body)
				}
			}
		})
	}
	// The older eras name their version in a header (or none) and need no _meta.
	for _, version := range []string{"", "2025-03-26", "2025-06-18", "2025-11-25"} {
		h := map[string]string{}
		if version != "" {
			h["MCP-Protocol-Version"] = version
		}
		if got := call(h, map[string]any{"name": "list_answers", "arguments": map[string]any{}}); got.status != http.StatusOK || got.Error != nil {
			t.Errorf("legacy header %q: %d %s", version, got.status, got.body)
		}
	}
}

// ownerActions is every HTTP route an agent key can't use, by name; the test proves each is refused to an agent.
var ownerActions = []string{
	"GET /api/passkeys", "POST /api/passkeys/register/begin", "POST /api/passkeys/register/finish",
	"POST /api/stepup/begin", "POST /api/stepup/finish", "POST /api/sessions/revoke-all",
	"DELETE /api/jobs/{jobId}", "DELETE /api/files/{fileId}", "DELETE /api/answers/{answerId}",
	"PATCH /api/config", "POST /api/import",
	"GET /api/tokens", "POST /api/tokens", "DELETE /api/tokens/{keyId}",
	"POST /api/mail/test", "POST /api/emails/{emailId}/approve",
}

// notAsTools are routes an agent may call over HTTP that have no MCP tool, and why.
var notAsTools = map[string]string{
	"GET /api":                          "the endpoint index; MCP has tools/list",
	"GET /api/docs":                     "the guide; MCP clients get the same words as the server instructions and tool descriptions",
	"GET /api/me":                       "who am I; an MCP client holds its own key",
	"GET /api/stats":                    "dashboard counts, for the UI",
	"GET /api/setup":                    "the setup screen",
	"POST /api/setup/claim":             "the setup screen",
	"PUT /api/jobs/{jobId}":             "create_job and update_job cover it",
	"POST /api/jobs/{jobId}/files":      "file bytes don't fit a tool call; use the HTTP API",
	"GET /api/files/{fileId}":           "file bytes don't fit a tool call; use the HTTP API",
	"GET /api/events":                   "the activity feed, for the UI; get_job has a job's timeline",
	"POST /api/events":                  "a log line with no job; add_job_event covers agent work",
	"PATCH /api/answers/{answerId}":     "ask_for_answer covers the agent's part; the owner fills answers in",
	"GET /api/resumes":                  "résumé files; use the HTTP API",
	"GET /api/export":                   "a full dump; use the HTTP API",
	"GET /api/mail":                     "the owner's sending status, for the UI",
	"PATCH /api/emails/{emailId}":       "not in the Phase 3b tool list; drafts are replaced by drafting again",
	"POST /api/emails/{emailId}/cancel": "not in the Phase 3b tool list; the owner cancels",
}

// TestToolListMatchesTheHTTPAPI: every tool mirrors a real agent route; every other route is either
// owner-only (and refused to an agent key) or named above with a reason. A new HTTP route fails here until someone decides.
func TestToolListMatchesTheHTTPAPI(t *testing.T) {
	r := newRig(t)
	_, secret := r.key("laptop")
	index := r.httpAsAgent(secret, http.MethodGet, "/api", nil).object(t)
	listed, _ := index["endpoints"].([]any)
	endpoints := map[string]bool{}
	for _, entry := range listed {
		endpoints[entry.(string)] = true
	}

	covered := map[string]string{}
	for _, info := range mcpapi.Catalog() {
		if !endpoints[info.Route] {
			t.Errorf("tool %s mirrors %q, which isn't an HTTP API route", info.Name, info.Route)
		}
		if previous, dup := covered[info.Route]; dup {
			t.Errorf("tools %s and %s mirror the same route %q", previous, info.Name, info.Route)
		}
		covered[info.Route] = info.Name
	}
	owner := map[string]bool{}
	for _, route := range ownerActions {
		owner[route] = true
		if _, both := covered[route]; both {
			t.Errorf("owner-only route %q has a tool (%s)", route, covered[route])
		}
		if !endpoints[route] {
			t.Errorf("owner-only list names %q, which isn't an HTTP API route", route)
		}
	}
	var undecided []string
	for route := range endpoints {
		_, tooled := covered[route]
		_, explained := notAsTools[route]
		if !tooled && !explained && !owner[route] {
			undecided = append(undecided, route)
		}
	}
	sort.Strings(undecided)
	if len(undecided) > 0 {
		t.Errorf("HTTP routes with no tool, no owner-only entry and no reason (add one of the three): %v", undecided)
	}
	for route := range notAsTools {
		if !endpoints[route] {
			t.Errorf("notAsTools names %q, which isn't an HTTP API route", route)
		}
	}

	// The owner-only list is true: an agent key is refused each of them over HTTP, so no tool could have run one.
	for _, route := range ownerActions {
		method, path, _ := strings.Cut(route, " ")
		path = regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(path, "x")
		got := r.httpAsAgent(secret, method, path, map[string]any{})
		if got.status != http.StatusForbidden {
			t.Errorf("%s as an agent: %d, want 403: %s", route, got.status, got.body)
		}
	}
}

// TestNoToolReachesAnOwnerAction: by name, by argument and by the owner's own fields.
func TestNoToolReachesAnOwnerAction(t *testing.T) {
	forEachEra(t, func(t *testing.T, r *rig, c *client) {
		forbidden := regexp.MustCompile(`approve|send|delete|remove|cancel|revoke|import|export|passkey|pitch|token|key|session|edit_email|set_|patch_config|update_config`)
		for _, name := range c.toolNames() {
			if forbidden.MatchString(name) {
				t.Errorf("tool %q sounds like an owner action", name)
			}
		}
		for _, name := range []string{
			"approve_email", "send_email", "delete_job", "delete_file", "delete_answer", "cancel_email", "edit_email", "update_config",
			"patch_config", "create_agent_key", "revoke_agent_key", "import_data", "set_live_pitch", "upload_file", "sign_out_everywhere",
		} {
			got := c.rpc("tools/call", map[string]any{"name": name, "arguments": map[string]any{"id": "x"}})
			if got.Error == nil || got.Error.Code != -32602 {
				t.Errorf("%s should be an unknown tool: %s", name, got.body)
			}
		}

		id := c.ok("create_job", map[string]any{"company": "Example Co", "title": "Engineer"})["id"].(string)
		c.ok("upsert_company_profile", map[string]any{"slug": "example-co", "name": "Example Co"})

		// An agent can't approve in the same breath as drafting; the word is refused out loud and nothing is written.
		for _, tool := range []struct {
			name string
			args map[string]any
		}{
			{"draft_job_email", map[string]any{"jobId": id, "to": "a@example.com", "subject": "S", "body": "B", "approve": true}},
			{"draft_company_email", map[string]any{"slug": "example-co", "to": "a@example.com", "subject": "S", "body": "B", "approve": true}},
		} {
			if message := c.refused(tool.name, tool.args); !strings.Contains(message, "approve") {
				t.Errorf("%s with approve: %s", tool.name, message)
			}
		}
		if outbox := c.ok("list_outbox", nil)["emails"].([]any); len(outbox) != 0 {
			t.Fatalf("a refused draft was written: %v", outbox)
		}
		draft := c.ok("draft_job_email", map[string]any{"jobId": id, "to": "a@example.com", "subject": "S", "body": "B"})
		if draft["status"] != "draft" || draft["approvedBy"] != nil || draft["sentAt"] != nil {
			t.Fatalf("a draft must wait for the owner: %v", draft)
		}
		// The owner still sees it as a draft only the owner can approve.
		if got := r.httpAsAgent(strings.TrimPrefix(c.secret, ""), http.MethodPost, "/api/emails/"+draft["id"].(string)+"/approve", map[string]any{"version": draft["version"]}); got.status != http.StatusForbidden {
			t.Errorf("approve by the same key over HTTP: %d", got.status)
		}

		// A field the owner wrote is the owner's: an agent can't overwrite or clear it, by any tool.
		if got := r.httpAsOwner(http.MethodPatch, "/api/jobs/"+id, map[string]any{"headsUp": "Owner says wait", "notes": "Owner notes"}); got.status != http.StatusOK {
			t.Fatalf("owner patch: %d %s", got.status, got.body)
		}
		for _, args := range []map[string]any{
			{"id": id, "headsUp": "Agent opinion"},
			{"id": id, "headsUp": nil},
			{"id": id, "notes": "Agent notes"},
		} {
			args := args
			if message := c.refused("update_job", args); !strings.Contains(message, "owner last wrote") {
				t.Errorf("update_job %v: %s", args, message)
			}
		}
		if job := c.ok("get_job", map[string]any{"id": id}); job["headsUp"] != "Owner says wait" || job["notes"] != "Owner notes" {
			t.Errorf("the owner's fields changed: %v %v", job["headsUp"], job["notes"])
		}
		c.ok("upsert_company_profile", map[string]any{"slug": "example-co", "quickTake": "From the agent."})
		r.httpAsOwner(http.MethodPatch, "/api/companies/example-co", map[string]any{"quickTake": "Owner's take"})
		if message := c.refused("upsert_company_profile", map[string]any{"slug": "example-co", "quickTake": "Agent again"}); !strings.Contains(message, "owner last wrote") {
			t.Errorf("company owner field: %s", message)
		}
	})
}

// TestAKeyIsNeverTheOwner: a key sent from the owner's own device is the agent, in the log and in what it may do.
func TestAKeyIsNeverTheOwner(t *testing.T) {
	r := newRig(t)
	_, secret := r.key("laptop")
	post := func(method string, params map[string]any) rpcResult {
		t.Helper()
		return decodeRPC(t, r.do(request{path: "/mcp", from: ownerAddr, headers: map[string]string{"Authorization": "Bearer " + secret, "Origin": tailnetOrigin}, body: map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}}))
	}
	created := post("tools/call", map[string]any{"name": "create_job", "arguments": map[string]any{"company": "Example Co", "title": "Engineer"}})
	if created.status != http.StatusOK || created.Error != nil {
		t.Fatalf("%d %s", created.status, created.body)
	}
	events := r.httpAsOwner(http.MethodGet, "/api/events?limit=5", nil)
	if !strings.Contains(string(events.body), `"actor":"agent:laptop","action":"Added job"`) {
		t.Errorf("the job should be logged to the agent, not the owner: %s", events.body)
	}
}

// TestNoSecretInResultsOrLogs: the key never comes back in a result or reaches a log line, even when calls fail.
func TestNoSecretInResultsOrLogs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	r := newRig(t)
	_, secret := r.key("laptop")
	var transcript strings.Builder
	for _, e := range []era{eraLegacy, eraModern} {
		c := r.connect(secret, e)
		id := c.ok("create_job", map[string]any{"company": "Example Co", "title": "Engineer " + e.String()})["id"].(string)
		for _, outcome := range []toolOutcome{
			c.call("get_job", map[string]any{"id": id}), c.call("get_job", map[string]any{"id": "missing"}),
			c.call("update_job", map[string]any{"id": id, "status": "bogus"}), c.call("get_search_config", nil),
		} {
			transcript.WriteString(outcome.text)
		}
		transcript.Write(c.post(map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/list"}, nil).body)
	}
	r.do(request{path: "/mcp", body: ping, headers: bearer(secret + "x")})
	for _, haystack := range []string{transcript.String(), logs.String()} {
		if strings.Contains(haystack, secret) || strings.Contains(haystack, strings.TrimPrefix(secret, auth.AgentKeyPrefix)) {
			t.Fatal("the key appeared in a result or a log line")
		}
	}
}
