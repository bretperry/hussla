// Replays every curl in the prototype's agent guide against the new API: an agent written for the prototype keeps working.
// In the app: the promise in docs/plans/hussla-v1.md (Phase 3 → Done when) that existing agents need no rewrite.
// Used by: `go test ./internal/httpapi/...`.
// Uses: docs/reference/prototype/agents-api.md (read as a file), the rig in harness_test.go.
//
// Each command is read from the guide's bash blocks, its shell variables ($JT, $H, $C) filled in,
// `<id>` replaced by a real job, and sent with an agent key; every one must answer 2xx.

package httpapi_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrototypeAgentExamples(t *testing.T) {
	guide, err := os.ReadFile(filepath.Join("..", "..", "docs", "reference", "prototype", "agents-api.md"))
	if err != nil {
		t.Fatal(err)
	}
	commands := curlCommands(string(guide))
	if want := strings.Count(string(guide), "curl "); len(commands) != want || want == 0 {
		t.Fatalf("parsed %d curl commands, but the guide has %d; the parser is missing some", len(commands), want)
	}

	r := newRig(t).enroll()
	secret := r.agentKey("prototype-agent")
	jobID := r.newJob("Staff Engineer")
	variables := map[string]string{
		"JT": "https://" + tailnetHost, "JT_KEY": secret,
		"H": "Authorization: Bearer " + secret, "C": "content-type: application/json",
	}
	for _, command := range commands {
		command = strings.ReplaceAll(command, "<id>", jobID)
		request, err := parseCurl(command, variables)
		if err != nil {
			t.Fatalf("%s: %v", command, err)
		}
		got := r.do(request)
		if got.status < 200 || got.status > 299 {
			t.Errorf("%s\n  → %d %s", command, got.status, got.body)
		}
	}
	// The writes landed: the PATCH moved the job on, and the contact is on it.
	job := r.must(http.StatusOK, asAgent(secret, http.MethodGet, "/api/jobs/"+jobID, nil)).json(t)
	contacts, _ := job["contacts"].([]any)
	if job["status"] != "applied" || len(contacts) != 1 {
		t.Fatalf("after the examples, the job is %v with contacts %v", job["status"], job["contacts"])
	}
}

// curlCommands returns each curl command in the guide's ```bash blocks, continuation lines (a
// trailing backslash, or a single-quoted body still open) joined and trailing comments dropped.
func curlCommands(markdown string) []string {
	var commands []string
	inBash := false
	var pending strings.Builder
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inBash = !inBash && strings.HasPrefix(trimmed, "```bash")
			continue
		}
		if !inBash {
			continue
		}
		if pending.Len() == 0 && !strings.HasPrefix(trimmed, "curl ") {
			continue
		}
		if continued, found := strings.CutSuffix(trimmed, `\`); found {
			pending.WriteString(continued + " ")
			continue
		}
		pending.WriteString(trimmed)
		if strings.Count(pending.String(), "'")%2 == 1 { // a quoted body runs on to the next line
			pending.WriteString(" ")
			continue
		}
		commands = append(commands, stripComment(pending.String()))
		pending.Reset()
	}
	return commands
}

// stripComment drops a trailing "# ..." that is outside quotes.
func stripComment(command string) string {
	var quote rune
	for index, character := range command {
		switch {
		case quote != 0 && character == quote:
			quote = 0
		case quote == 0 && (character == '\'' || character == '"'):
			quote = character
		case quote == 0 && character == '#' && index > 0 && command[index-1] == ' ':
			return strings.TrimSpace(command[:index])
		}
	}
	return command
}

// shellWords splits a command the way sh would for these examples: single quotes literal, double
// quotes and bare words with $NAME expanded.
func shellWords(command string, variables map[string]string) []string {
	var words []string
	var word strings.Builder
	inWord := false
	expand := func(text string) string {
		// Longest names first, so $JT_KEY isn't read as $JT + "_KEY".
		for _, name := range []string{"JT_KEY", "JT", "H", "C"} {
			text = strings.ReplaceAll(text, "$"+name, variables[name])
		}
		return text
	}
	for index := 0; index < len(command); index++ {
		character := command[index]
		switch character {
		case ' ', '\t':
			if inWord {
				words = append(words, word.String())
				word.Reset()
				inWord = false
			}
		case '\'':
			end := strings.IndexByte(command[index+1:], '\'')
			word.WriteString(command[index+1 : index+1+end])
			index += end + 1
			inWord = true
		case '"':
			end := strings.IndexByte(command[index+1:], '"')
			word.WriteString(expand(command[index+1 : index+1+end]))
			index += end + 1
			inWord = true
		default:
			start := index
			for index < len(command) && !strings.ContainsRune(" \t'\"", rune(command[index])) {
				index++
			}
			word.WriteString(expand(command[start:index]))
			index--
			inWord = true
		}
	}
	if inWord {
		words = append(words, word.String())
	}
	return words
}

// parseCurl turns one curl command into a rig call made with the agent's key, from off the tailnet.
func parseCurl(command string, variables map[string]string) (call, error) {
	words := shellWords(command, variables)
	request := call{method: http.MethodGet, from: offAddr, headers: map[string]string{}}
	for index := 1; index < len(words); index++ {
		switch word := words[index]; word {
		case "-s":
		case "-X":
			index++
			request.method = words[index]
		case "-H":
			index++
			name, value, _ := strings.Cut(words[index], ":")
			request.headers[http.CanonicalHeaderKey(strings.TrimSpace(name))] = strings.TrimSpace(value)
		case "-d", "--data-binary":
			index++
			body := words[index]
			if strings.HasPrefix(body, "@") {
				body = "%PDF-1.4 synthetic test file\n" // the example uploads a local file
			}
			request.body = []byte(body)
			if request.method == http.MethodGet {
				request.method = http.MethodPost
			}
		default:
			request.path = strings.TrimPrefix(word, variables["JT"])
		}
	}
	return request, nil
}
