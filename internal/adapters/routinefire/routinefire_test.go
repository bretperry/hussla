// Tests for the routine Firer against a fake /fire endpoint: the request it sends, and what each answer means.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package routinefire_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/routinefire"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
	"github.com/bretperry/hussla/internal/config"
)

const secretToken = "sk-ant-oat01-secret"

func fireAgainst(t *testing.T, handler http.HandlerFunc) (searchrun.Fired, error) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return routinefire.NewForTest(server.URL).Fire(context.Background(), "trig_01ABC", mailsetup.NewSecret(secretToken), "Started from Hussla")
}

func TestFireSendsTheDocumentedRequest(t *testing.T) {
	fired, err := fireAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/claude_code/routines/trig_01ABC/fire" {
			t.Errorf("request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+secretToken || r.Header.Get("anthropic-beta") != config.RoutineFireBeta ||
			r.Header.Get("anthropic-version") != config.RoutineFireAPIVersion {
			t.Errorf("headers: %v", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]string
		if err := json.Unmarshal(raw, &body); err != nil || body["text"] != "Started from Hussla" {
			t.Errorf("body: %s", raw)
		}
		_, _ = w.Write([]byte(`{"type":"routine_fire","claude_code_session_id":"session_01X","claude_code_session_url":"https://claude.ai/code/session_01X"}`))
	})
	if err != nil || fired.SessionURL != "https://claude.ai/code/session_01X" {
		t.Fatalf("fired: %+v, %v", fired, err)
	}
}

func TestFireDropsALinkOffClaude(t *testing.T) {
	fired, err := fireAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"claude_code_session_url":"https://evil.example/phish"}`))
	})
	if err != nil || fired.SessionURL != "" {
		t.Fatalf("fired: %+v, %v", fired, err)
	}
}

func TestFireStatuses(t *testing.T) {
	cases := map[int]error{
		http.StatusUnauthorized:    searchrun.ErrTokenRejected,
		http.StatusForbidden:       searchrun.ErrTokenRejected,
		http.StatusNotFound:        searchrun.ErrRoutineNotFound,
		http.StatusTooManyRequests: searchrun.ErrRateLimited,
	}
	for status, want := range cases {
		_, err := fireAgainst(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
		if !errors.Is(err, want) {
			t.Errorf("%d: want %v, got %v", status, want, err)
		}
	}
}

func TestFireErrorNeverHoldsTheToken(t *testing.T) {
	_, err := fireAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"bad token ` + secretToken + `"}`))
	})
	var fireError *searchrun.FireError
	if !errors.As(err, &fireError) {
		t.Fatalf("want a FireError, got %v", err)
	}
	if strings.Contains(fireError.Reason, secretToken) || !strings.Contains(fireError.Reason, "500") || !fireError.MaybeStarted {
		t.Fatalf("reason: %q, maybe started %v", fireError.Reason, fireError.MaybeStarted)
	}
}

// A token that straddles the excerpt's cut must not leak its start.
func TestFireErrorRedactsBeforeCutting(t *testing.T) {
	_, err := fireAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(strings.Repeat("x", 289) + " Bearer " + secretToken))
	})
	var fireError *searchrun.FireError
	if !errors.As(err, &fireError) {
		t.Fatalf("want a FireError, got %v", err)
	}
	if strings.Contains(fireError.Reason, "sk-") || fireError.MaybeStarted {
		t.Fatalf("reason: %q, maybe started %v", fireError.Reason, fireError.MaybeStarted)
	}
}

func TestADroppedConnectionMayHaveStarted(t *testing.T) {
	_, err := fireAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		connection, _, hijackErr := http.NewResponseController(w).Hijack()
		if hijackErr != nil {
			t.Error(hijackErr)
			return
		}
		_ = connection.Close()
	})
	var fireError *searchrun.FireError
	if !errors.As(err, &fireError) || !fireError.MaybeStarted {
		t.Fatalf("want a FireError that may have started, got %v", err)
	}
}

func TestFireDoesNotFollowRedirects(t *testing.T) {
	var redirected bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	t.Cleanup(target.Close)
	_, err := fireAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	if redirected {
		t.Fatal("followed a redirect, carrying the token elsewhere")
	}
	var fireError *searchrun.FireError
	if !errors.As(err, &fireError) {
		t.Fatalf("want a FireError, got %v", err)
	}
}
