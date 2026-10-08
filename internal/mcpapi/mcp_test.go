// What an agent can do through /mcp: every tool, in both protocol eras, over the real router and use-cases.
// In the app: nothing at runtime (tests only).
// Used by: go test ./internal/mcpapi/...
// Uses: the rig and client in harness_test.go.

package mcpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/mcpapi"
)

// TestEveryToolThroughTheClient walks one agent's job: every tool runs, over MCP, and the work lands.
func TestEveryToolThroughTheClient(t *testing.T) {
	forEachEra(t, func(t *testing.T, _ *rig, c *client) {
		created := c.ok("create_job", map[string]any{
			"company": "Example Co", "title": "Staff Engineer", "url": "https://example.com/jobs/1", "workType": "remote",
			"score": 80, "reasons": []string{"TypeScript match"},
		})
		id, _ := created["id"].(string)
		if id == "" || created["status"] != "review" {
			t.Fatalf("create_job: %v", created)
		}
		if again := c.refused("create_job", map[string]any{"id": id, "company": "Example Co", "title": "Staff Engineer"}); !strings.Contains(again, "already exists") {
			t.Fatalf("duplicate create: %s", again)
		}

		found := c.ok("find_jobs", map[string]any{"status": "review,queued", "q": "staff"})
		jobs, _ := found["jobs"].([]any)
		if len(jobs) != 1 || found["total"] != float64(1) || found["truncated"] != false {
			t.Fatalf("find_jobs: %v", found)
		}
		if listed := c.ok("find_jobs", map[string]any{"status": []string{"applied"}}); listed["total"] != float64(0) {
			t.Fatalf("find_jobs by array status: %v", listed)
		}

		updated := c.ok("update_job", map[string]any{"id": id, "status": "queued", "nextAction": "Apply on the company site", "note": "Checked the posting is real"})
		if updated["status"] != "queued" || updated["score"] != float64(80) {
			t.Fatalf("update_job should patch, not replace: %v", updated)
		}
		c.ok("add_job_event", map[string]any{"jobId": id, "action": "Researched", "detail": "Read the careers page"})
		withContact := c.ok("add_contact", map[string]any{"jobId": id, "name": "Jamie Recruiter", "email": "jamie@example.com", "emailStatus": "verified", "role": "Recruiter"})
		if contacts, _ := withContact["contacts"].([]any); len(contacts) != 1 {
			t.Fatalf("add_contact: %v", withContact)
		}

		company := c.ok("upsert_company_profile", map[string]any{
			"slug": "example-co", "name": "Example Co", "quickTake": "Small and steady.", "profile": map[string]any{"hq": "Springfield"},
		})
		if company["slug"] != "example-co" || company["quickTake"] != "Small and steady." {
			t.Fatalf("upsert_company_profile: %v", company)
		}
		c.ok("add_company_news", map[string]any{"slug": "example-co", "date": "2026-10-01", "headline": "Example Co opens an office", "url": "https://example.com/news/1"})
		withReview := c.ok("add_company_review", map[string]any{"slug": "example-co", "source": "Glassdoor", "rating": 4.1, "ratingScale": 5, "reviewCount": 120, "summary": "Mostly positive."})
		if reviews, _ := withReview["reviews"].([]any); len(reviews) != 1 {
			t.Fatalf("add_company_review: %v", withReview)
		}
		if page := c.ok("get_company", map[string]any{"slug": "example-co"}); page["name"] != "Example Co" || len(page["news"].([]any)) != 1 {
			t.Fatalf("get_company: %v", page)
		}
		if all := c.ok("list_companies", nil); len(all["companies"].([]any)) != 1 {
			t.Fatalf("list_companies: %v", all)
		}

		detail := c.ok("get_job", map[string]any{"id": id})
		events, _ := detail["events"].([]any)
		var actors []string
		for _, entry := range events {
			actors = append(actors, entry.(map[string]any)["actor"].(string))
		}
		if len(events) == 0 || slices.ContainsFunc(actors, func(actor string) bool { return actor != "agent:laptop" }) {
			t.Fatalf("every event should be named for the agent key: %v", actors)
		}

		draft := c.ok("draft_job_email", map[string]any{"jobId": id, "to": "jamie@example.com", "subject": "Following up", "body": "Hello Jamie, I applied last week."})
		if draft["status"] != "draft" || draft["kind"] != "follow-up" || draft["createdBy"] != "agent:laptop" {
			t.Fatalf("draft_job_email: %v", draft)
		}
		companyDraft := c.ok("draft_company_email", map[string]any{"slug": "example-co", "to": []string{"hello@example.com"}, "subject": "Hello", "body": "A note.", "jobId": id})
		if companyDraft["status"] != "draft" || companyDraft["kind"] != "note" {
			t.Fatalf("draft_company_email: %v", companyDraft)
		}
		outbox := c.ok("list_outbox", map[string]any{"status": "draft", "jobId": id})
		if emails, _ := outbox["emails"].([]any); len(emails) != 2 {
			t.Fatalf("list_outbox: %v", outbox)
		}

		question := c.ok("ask_for_answer", map[string]any{"question": "Are you authorized to work in the US?", "jobIds": []string{id}})
		if question["answer"] != "" && question["answer"] != nil {
			t.Fatalf("a question with no answer should stay unanswered: %v", question)
		}
		if answers := c.ok("list_answers", nil); len(answers["answers"].([]any)) != 1 {
			t.Fatalf("list_answers: %v", answers)
		}
		c.ok("get_search_config", nil)

		// Every tool the server lists was just run.
		for _, name := range c.toolNames() {
			if !c.called[name] {
				t.Errorf("tool %s was not exercised", name)
			}
		}
	})
}

// TestToolsReturnWhatTheAPIReturns holds each read tool to the HTTP route it mirrors, so the two doors can't drift.
func TestToolsReturnWhatTheAPIReturns(t *testing.T) {
	forEachEra(t, func(t *testing.T, r *rig, c *client) {
		_, secret := r.key("second")
		id := c.ok("create_job", map[string]any{"company": "Example Co", "title": "Engineer", "score": 70})["id"].(string)
		c.ok("upsert_company_profile", map[string]any{"slug": "example-co", "name": "Example Co", "quickTake": "Fine."})
		c.ok("draft_job_email", map[string]any{"jobId": id, "to": "a@example.com", "subject": "S", "body": "B"})
		c.ok("ask_for_answer", map[string]any{"question": "Preferred name?"})

		same := func(label string, fromTool any, route string) {
			t.Helper()
			over := r.httpAsAgent(secret, http.MethodGet, route, nil)
			if over.status != http.StatusOK {
				t.Fatalf("%s: GET %s = %d", label, route, over.status)
			}
			var fromAPI any
			if err := json.Unmarshal(over.body, &fromAPI); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(fromTool, fromAPI) {
				t.Errorf("%s differs from GET %s\n tool: %v\n http: %v", label, route, fromTool, fromAPI)
			}
		}
		same("get_job", c.ok("get_job", map[string]any{"id": id}), "/api/jobs/"+id)
		same("find_jobs", c.ok("find_jobs", nil)["jobs"], "/api/jobs")
		same("get_company", c.ok("get_company", map[string]any{"slug": "example-co"}), "/api/companies/example-co")
		same("list_companies", c.ok("list_companies", nil)["companies"], "/api/companies")
		same("list_outbox", c.ok("list_outbox", nil)["emails"], "/api/emails")
		same("list_answers", c.ok("list_answers", nil)["answers"], "/api/answers")
		same("get_search_config", c.ok("get_search_config", nil), "/api/config")
	})
}

// TestMistakesAreToolErrors: what the model can fix comes back as isError text; what it can't is a JSON-RPC error.
func TestMistakesAreToolErrors(t *testing.T) {
	forEachEra(t, func(t *testing.T, _ *rig, c *client) {
		if message := c.refused("create_job", map[string]any{"company": "Example Co"}); !strings.Contains(message, "title") {
			t.Errorf("a missing title should be named: %s", message)
		}
		if message := c.refused("update_job", map[string]any{"id": "no-such-job", "status": "queued"}); !strings.Contains(message, "not found") {
			t.Errorf("unknown job: %s", message)
		}
		id := c.ok("create_job", map[string]any{"company": "Example Co", "title": "Engineer"})["id"].(string)
		if message := c.refused("update_job", map[string]any{"id": id, "status": "hired"}); !strings.Contains(message, "status") {
			t.Errorf("bad status should be named: %s", message)
		}
		if message := c.refused("get_job", map[string]any{"id": id, "extra": 1}); !strings.Contains(message, "extra") {
			t.Errorf("an unknown argument should be named: %s", message)
		}
		if message := c.refused("find_jobs", map[string]any{"status": "nonsense"}); !strings.Contains(message, "nonsense") {
			t.Errorf("a bad status filter should be named: %s", message)
		}

		unknown := c.rpc("tools/call", map[string]any{"name": "no_such_tool", "arguments": map[string]any{}})
		if unknown.Error == nil || unknown.Error.Code != -32602 {
			t.Errorf("unknown tool: %s", unknown.body)
		}
		notObject := c.rpc("tools/call", map[string]any{"name": "list_answers", "arguments": []any{1}})
		if notObject.Error == nil || notObject.Error.Code != -32602 {
			t.Errorf("non-object arguments: %s", notObject.body)
		}
		missing := c.rpc("no/such/method", nil)
		if missing.Error == nil || missing.Error.Code != -32601 {
			t.Errorf("unknown method: %s", missing.body)
		}
		wantStatus := http.StatusOK
		if c.era == eraModern {
			wantStatus = http.StatusNotFound
		}
		if missing.status != wantStatus {
			t.Errorf("unknown method status %d, want %d", missing.status, wantStatus)
		}
	})
}

// TestToolListIsTheDocumentedSet pins the names and what each one declares, and that agents-api.md names every tool.
func TestToolListIsTheDocumentedSet(t *testing.T) {
	forEachEra(t, func(t *testing.T, _ *rig, c *client) {
		answer := c.rpc("tools/list", nil)
		list, _ := answer.Result["tools"].([]any)
		var names []string
		for _, entry := range list {
			tool := entry.(map[string]any)
			names = append(names, tool["name"].(string))
			annotations, _ := tool["annotations"].(map[string]any)
			schema, _ := tool["inputSchema"].(map[string]any)
			if tool["description"] == "" || schema["type"] != "object" || annotations["destructiveHint"] != false || annotations["openWorldHint"] != false {
				t.Errorf("tool %v is under-described: %v", tool["name"], tool)
			}
			if readOnly, _ := annotations["readOnlyHint"].(bool); readOnly && annotations["idempotentHint"] != true {
				t.Errorf("a read-only tool is idempotent: %v", tool["name"])
			}
		}
		want := []string{
			"find_jobs", "get_job", "create_job", "update_job", "add_job_event", "add_contact",
			"list_companies", "get_company", "upsert_company_profile", "add_company_news", "add_company_review",
			"draft_job_email", "draft_company_email", "list_outbox", "list_answers", "ask_for_answer", "get_search_config",
		}
		if !slices.Equal(names, want) {
			t.Errorf("tools/list = %v\n want %v", names, want)
		}
	})
	guide, err := os.ReadFile("../../docs/agents-api.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, info := range mcpapi.Catalog() {
		if !strings.Contains(string(guide), "`"+info.Name+"`") {
			t.Errorf("docs/agents-api.md doesn't mention tool `%s`", info.Name)
		}
	}
}

func TestDiscoverAndInitialize(t *testing.T) {
	r := newRig(t)
	_, secret := r.key("laptop")

	modern := r.connect(secret, eraModern)
	discovered := modern.rpc("server/discover", nil)
	versions, _ := discovered.Result["supportedVersions"].([]any)
	if discovered.status != http.StatusOK || len(versions) < 2 || versions[0] != "2026-07-28" {
		t.Fatalf("server/discover: %s", discovered.body)
	}
	if caps, _ := discovered.Result["capabilities"].(map[string]any); caps["tools"] == nil {
		t.Fatalf("discover should declare tools: %s", discovered.body)
	}

	legacy := &client{r: r, t: t, secret: secret, era: eraLegacy}
	for _, ask := range []string{"2025-06-18", "2025-03-26"} {
		got := legacy.rpc("initialize", map[string]any{"protocolVersion": ask, "capabilities": map[string]any{}})
		if got.Result["protocolVersion"] != ask {
			t.Errorf("initialize should echo %s: %s", ask, got.body)
		}
	}
	if got := legacy.rpc("initialize", map[string]any{"protocolVersion": "2099-01-01"}); got.Result["protocolVersion"] != "2025-11-25" {
		t.Errorf("an unknown ask gets the newest legacy revision: %s", got.body)
	}
	if got := legacy.rpc("ping", nil); got.status != http.StatusOK || got.Error != nil {
		t.Errorf("ping: %s", got.body)
	}
	stateless := decodeRPC(t, modern.post(
		map[string]any{"jsonrpc": "2.0", "id": 99, "method": "initialize", "params": map[string]any{"_meta": modernMeta()}},
		map[string]string{"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "initialize"}))
	if stateless.Error == nil {
		t.Errorf("a stateless request must not use initialize: %s", stateless.body)
	}
}
