// The tailnet door's fail-closed check: when the node is logged in to Tailscale as someone other than the recorded owner, it answers nothing but "belongs to someone else".
// In the app: after a Tailscale key expiry, if someone on the home network signed the node in with their own account, every tailnet page and API call says so until the owner reconnects from the home-network page.
// Used by: cmd/hussla (wraps the whole tailnet handler, /mcp included).
// Uses: setup.Service.OwnerMismatch.
//
// Why a wrapper around everything, and not only the identity step: in that state the tailnet is
// someone else's, so no caller on it (a peer, an agent key, even a user id that happens to match)
// should reach the API or /mcp. The page names no one, so it tells the other account nothing.

package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/bretperry/hussla/internal/app/setup"
)

// GuardNodeOwner serves next only while the node is not logged in as someone other than the owner.
func GuardNodeOwner(service *setup.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mismatch, err := service.OwnerMismatch(r.Context())
		if err != nil {
			slog.Error("node owner check", "error", err)
			writeError(w, http.StatusInternalServerError, errorBody{Error: "something went wrong on the server; see its log"})
			return
		}
		if !mismatch {
			next.ServeHTTP(w, r)
			return
		}
		header := w.Header()
		header.Set("Cache-Control", "no-store")
		header.Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusForbidden, errorBody{Error: errSomeoneElse})
			return
		}
		header.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		header.Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(someoneElsePage))
	})
}

const errSomeoneElse = "this Hussla belongs to someone else: it is signed in to a Tailscale account that isn't its owner's"

const someoneElsePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not your Hussla</title></head>
<body>
<h1>This Hussla belongs to someone else</h1>
<p>It is signed in to a Tailscale account that isn't its owner's, so it answers nothing here. Its owner can sign it in again from its home-network page.</p>
</body>
</html>
`
