// The tailnet join loop and the owner-pin log line, without a real tailnet.
// In the app: a headless first run with HTTPS off or a broken join; a HUSSLA_OWNER_LOGIN typo.
// Used by: `go test ./cmd/hussla/`.
// Uses: a scripted fake node, the auth use-case over the in-memory store, testing/synctest for the backoff.

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/bretperry/hussla/internal/adapters/tailnet"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

// scriptedNode fails Up with each error in ups (nil = success), then succeeds.
type scriptedNode struct {
	mutex sync.Mutex
	ups   []error
	calls []time.Time
}

func (node *scriptedNode) Up(context.Context) error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.calls = append(node.calls, time.Now())
	if len(node.ups) == 0 {
		return nil
	}
	err := node.ups[0]
	node.ups = node.ups[1:]
	return err
}

func (node *scriptedNode) Listener() (net.Listener, error) { return fakeListener{}, nil }

type fakeListener struct{ net.Listener }

func (fakeListener) Close() error { return nil }

func TestJoinTailnetRetriesUntilHTTPSIsOn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var log bytes.Buffer
		logger := slog.New(slog.NewTextHandler(&log, nil))
		node := &scriptedNode{ups: []error{
			errors.New("join the tailnet: backend: no route"), // a join failure: logged, retried
			tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff,
		}}
		listener, err := joinTailnet(t.Context(), node, logger)
		if err != nil || listener == nil {
			t.Fatalf("join: %v", err)
		}
		if len(node.calls) != 7 {
			t.Fatalf("%d tries, want 7", len(node.calls))
		}
		// Backoff: doubles from the first wait and stops at the cap.
		var waits []time.Duration
		for index := 1; index < len(node.calls); index++ {
			waits = append(waits, node.calls[index].Sub(node.calls[index-1]))
		}
		want := config.TailnetRetryFirst
		for index, wait := range waits {
			if wait != want {
				t.Fatalf("wait %d is %v, want %v (all: %v)", index, wait, want, waits)
			}
			want = min(want*2, config.TailnetRetryMax)
		}
		if waits[len(waits)-1] != config.TailnetRetryMax {
			t.Fatalf("waits never reached the cap: %v", waits)
		}
		text := log.String()
		if strings.Count(text, "turn on MagicDNS and HTTPS Certificates") != 1 {
			t.Fatalf("want the HTTPS hint once:\n%s", text)
		}
		if strings.Count(text, "no route") != 1 {
			t.Fatalf("want the join failure once:\n%s", text)
		}
	})
}

func TestJoinTailnetStopsWhenTheServerStops(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		node := &scriptedNode{ups: []error{tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff, tailnet.ErrHTTPSOff}}
		go func() {
			time.Sleep(config.TailnetRetryFirst + time.Second)
			cancel()
		}()
		if _, err := joinTailnet(ctx, node, slog.New(slog.DiscardHandler)); !errors.Is(err, context.Canceled) {
			t.Fatalf("want canceled, got %v", err)
		}
	})
}

func TestOwnerPinMismatchIsLogged(t *testing.T) {
	ctx := context.Background()
	service := auth.New(auth.Options{Store: fakes.New(), OwnerLogin: "owner@example.com"})
	var log bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&log, nil))
	adoptNodeOwner(ctx, service, auth.TailnetPeer{UserID: "2002", Login: "guest@example.com"}, logger)
	text := log.String()
	if strings.Count(text, "\n") != 1 || !strings.Contains(text, "guest@example.com") || !strings.Contains(text, "owner@example.com") {
		t.Fatalf("want one line naming both logins:\n%s", text)
	}
	if enrolled, err := service.Enrolled(ctx); err != nil || enrolled {
		t.Fatalf("enrolled %v %v", enrolled, err)
	}

	// The pinned login itself is adopted, with no mismatch line.
	log.Reset()
	adoptNodeOwner(ctx, service, auth.TailnetPeer{UserID: "1001", Login: "Owner@Example.com"}, logger)
	if strings.Contains(log.String(), "doesn't match") {
		t.Fatalf("mismatch logged for the pinned login:\n%s", log.String())
	}
}

// TestMCPIsMountedBesideTheAPI: /mcp goes to the MCP handler, everything else to the HTTP API, and nothing falls between.
func TestMCPIsMountedBesideTheAPI(t *testing.T) {
	answer := func(name string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, name) })
	}
	mounted := withMCP(answer("api"), answer("mcp"))
	for path, want := range map[string]string{"/mcp": "mcp", "/api/jobs": "api", "/": "api", "/mcp/": "api", "/mcpx": "api", "/healthz": "api"} {
		recorder := httptest.NewRecorder()
		mounted.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
		if got := recorder.Body.String(); got != want {
			t.Errorf("%s went to %q, want %q", path, got, want)
		}
	}
}
