// The tailnet's plain-HTTP door: every request goes to the full https:// address.
// In the app: typing `hussla` or `http://hussla.<tailnet>.ts.net` on a device on the tailnet lands on the real address.
// Used by: cmd/hussla (a listener on the tailnet's port 80).
//
// It serves nothing itself and reads no identity. The target is the node's current name, read on
// each request (a rename moves it), never the request's Host, so it can't be steered elsewhere.

package httpapi

import "net/http"

// NewRedirect sends every request to https://<domain()> with the same path and query.
func NewRedirect(domain func() string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := domain()
		if name == "" {
			http.Error(w, "Hussla isn't serving HTTPS yet.", http.StatusServiceUnavailable)
			return
		}
		target := "https://" + name + r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
	})
}
