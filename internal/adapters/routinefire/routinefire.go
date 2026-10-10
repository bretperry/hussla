// The Firer for Claude routines: one POST to a routine's API trigger, https://api.anthropic.com/v1/claude_code/routines/{id}/fire.
// In the app: the Search now button starts the owner's job-search routine through it.
// Used by: cmd/hussla (wires it into searchrun).
// Uses: net/http, config.RoutineFire* (the host, headers and timeout), mailsetup.Redact for failure text.
//
// The URL is built here from config.RoutineFireBaseURL and the routine id, never taken from the
// owner, and redirects are not followed: the bearer token can only ever reach that one host.
// Docs: https://code.claude.com/docs/en/routines → Trigger a routine.

package routinefire

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
	"github.com/bretperry/hussla/internal/config"
)

// maxReplyBytes caps how much of the reply is read; the success body is a few hundred bytes.
const maxReplyBytes = 64 << 10

// maxReasonLength caps the reply text kept in a failure reason.
const maxReasonLength = 300

// sessionURLPrefix is the only kind of link passed on to the page as "watch the run".
const sessionURLPrefix = "https://claude.ai/"

// Client fires routines.
type Client struct {
	http    *http.Client
	baseURL string
}

// New builds the production client.
func New() *Client { return newClient(config.RoutineFireBaseURL) }

// NewForTest builds a client against a fake server (an httptest URL).
func NewForTest(baseURL string) *Client { return newClient(baseURL) }

func newClient(baseURL string) *Client {
	transport := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2: true,
	}
	return &Client{
		http: &http.Client{
			Transport:     transport,
			Timeout:       config.RoutineFireTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		baseURL: strings.TrimRight(baseURL, "/"),
	}
}

type fireReply struct {
	SessionURL string `json:"claude_code_session_url"`
}

// Fire starts one run. Errors: searchrun.ErrTokenRejected, ErrRoutineNotFound, ErrRateLimited, or a *searchrun.FireError.
func (client *Client) Fire(ctx context.Context, routineID string, token mailsetup.Secret, text string) (searchrun.Fired, error) {
	// searchrun.ParseRoutineID already allows only letters, digits and "_"; escaping again keeps a
	// future caller from steering the path.
	endpoint := client.baseURL + "/v1/claude_code/routines/" + url.PathEscape(routineID) + "/fire"
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return searchrun.Fired{}, fmt.Errorf("encode the fire request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return searchrun.Fired{}, &searchrun.FireError{Reason: "build the fire request: " + mailsetup.Redact(err.Error(), token)}
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("anthropic-beta", config.RoutineFireBeta)
	request.Header.Set("anthropic-version", config.RoutineFireAPIVersion)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return searchrun.Fired{}, &searchrun.FireError{Reason: "couldn't reach Claude: " + mailsetup.Redact(err.Error(), token)}
	}
	defer func() { _ = response.Body.Close() }()
	reply, readErr := io.ReadAll(io.LimitReader(response.Body, maxReplyBytes))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		var parsed fireReply
		// The run started whatever the body says; a reply we can't read only loses the link.
		if readErr == nil && json.Unmarshal(reply, &parsed) == nil && strings.HasPrefix(parsed.SessionURL, sessionURLPrefix) {
			return searchrun.Fired{SessionURL: parsed.SessionURL}, nil
		}
		return searchrun.Fired{}, nil
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return searchrun.Fired{}, searchrun.ErrTokenRejected
	case response.StatusCode == http.StatusNotFound:
		return searchrun.Fired{}, searchrun.ErrRoutineNotFound
	case response.StatusCode == http.StatusTooManyRequests:
		return searchrun.Fired{}, searchrun.ErrRateLimited
	}
	reason := fmt.Sprintf("Claude answered %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	if readErr == nil {
		if text := excerpt(reply); text != "" {
			reason += ": " + mailsetup.Redact(text, token)
		}
	}
	return searchrun.Fired{}, &searchrun.FireError{Reason: reason}
}

// excerpt is the start of a reply, on one line, for a failure reason.
func excerpt(reply []byte) string {
	text := strings.Join(strings.Fields(string(reply)), " ")
	if len(text) > maxReasonLength {
		text = text[:maxReasonLength] + "…"
	}
	return text
}
