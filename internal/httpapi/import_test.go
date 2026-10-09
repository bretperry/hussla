// The owner's "Import from the old tracker": the prototype's export through POST /api/import, twice.
// In the app: Settings → Import from the old tracker.
// Uses: docs/reference/prototype/export-sample.json (synthetic), the rig in harness_test.go.

package httpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type importReply struct {
	Jobs             int      `json:"jobs"`
	Emails           int      `json:"emails"`
	Pitches          int      `json:"pitches"`
	Events           int      `json:"events"`
	NeedApproval     int      `json:"needApproval"`
	FilesNotImported int      `json:"filesNotImported"`
	Warnings         []string `json:"warnings"`
	Notices          []string `json:"notices"`
}

func TestImportFromTheOldTrackerTwiceAddsNothing(t *testing.T) {
	sample, err := os.ReadFile(filepath.Join("..", "..", "docs", "reference", "prototype", "export-sample.json"))
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t).enroll()
	post := func() importReply {
		var got importReply
		if err := json.Unmarshal(r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/import", sample)).body, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	eventCount := func() int {
		var list []json.RawMessage
		if err := json.Unmarshal(r.must(http.StatusOK, call{path: "/api/events?limit=1000"}).body, &list); err != nil {
			t.Fatal(err)
		}
		return len(list)
	}

	first := post()
	if first.Jobs != 4 || first.Emails != 5 || first.NeedApproval != 3 || first.FilesNotImported != 1 {
		t.Errorf("first import = %+v", first)
	}
	if len(first.Notices) == 0 || !strings.Contains(strings.Join(first.Notices, " "), "never imported") {
		t.Errorf("the reply must say secrets aren't imported: %v", first.Notices)
	}
	eventsAfterFirst := eventCount()

	second := post()
	if second.Jobs != 0 || second.Emails != 0 || second.Events != 0 {
		t.Errorf("second import added records: %+v", second)
	}
	if got := eventCount(); got != eventsAfterFirst {
		t.Errorf("a second import added %d activity lines", got-eventsAfterFirst)
	}

	var approved []json.RawMessage
	if err := json.Unmarshal(r.must(http.StatusOK, call{path: "/api/emails?status=approved"}).body, &approved); err != nil {
		t.Fatal(err)
	}
	if len(approved) != 0 {
		t.Errorf("an import must never leave an email approved, found %d", len(approved))
	}
}

// TestImportCountsPitchesAndLogsOnce: one import leaves one activity line, and pitches show in the reply.
func TestImportCountsPitchesAndLogsOnce(t *testing.T) {
	sample, err := os.ReadFile(filepath.Join("..", "..", "docs", "reference", "prototype", "export-sample.json"))
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t).enroll()
	importLines := func() int {
		var events []struct {
			Action string `json:"action"`
		}
		if err := json.Unmarshal(r.must(http.StatusOK, call{path: "/api/events?limit=1000"}).body, &events); err != nil {
			t.Fatal(err)
		}
		lines := 0
		for _, event := range events {
			if strings.HasPrefix(event.Action, "Imported") {
				lines++
			}
		}
		return lines
	}
	r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/import", sample))
	if lines := importLines(); lines != 1 {
		t.Errorf("one import left %d activity lines, want 1", lines)
	}

	pitches := []byte(`{"pitches": [
		{"slot": 1, "title": "The short one", "when": "A first call", "text": "I build calm tools for busy people."},
		{"slot": 2, "title": "The long one", "when": "A panel", "text": "I have shipped trackers, mailers and dashboards."}
	]}`)
	var got importReply
	if err := json.Unmarshal(r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/import", pitches)).body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Pitches != 2 {
		t.Errorf("pitches in the reply = %d, want 2: %+v", got.Pitches, got)
	}
}

// TestAMalformedImportFileIsTheUploadersMistake: a file that isn't a bundle is a 400 that says why, not a 500.
func TestAMalformedImportFileIsTheUploadersMistake(t *testing.T) {
	r := newRig(t).enroll()
	for _, file := range []string{`not json`, `{"jobs": 5}`, `[1, 2]`, `"a string"`} {
		reply := r.must(http.StatusBadRequest, r.ownerStepUp(http.MethodPost, "/api/import", []byte(file)))
		if !strings.Contains(string(reply.body), "seed file") {
			t.Errorf("%s: the refusal doesn't say what's wrong: %s", file, reply.body)
		}
	}
}
