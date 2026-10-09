// GET /api/me: who is calling, the product name and the server's version, for the owner and for an agent.
// In the app: the page header's name and the "Hussla v0.1.1" line on Settings.
// Used by: go test.
// Uses: the rig (harness_test.go); the response contract check runs on every answer.

package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/bretperry/hussla/internal/config"
)

func TestMeNamesTheProductAndVersion(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("scout")
	for name, c := range map[string]call{"owner": {path: "/api/me"}, "agent": asAgent(secret, http.MethodGet, "/api/me", nil)} {
		got := r.must(http.StatusOK, c).json(t)
		if got["appName"] != config.ProductName || got["version"] != config.Version {
			t.Fatalf("%s: appName %v, version %v; want %q, %q", name, got["appName"], got["version"], config.ProductName, config.Version)
		}
	}
}
