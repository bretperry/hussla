// The router and api/openapi.yaml list the same API routes: a route can't ship undocumented, and the contract can't promise one that doesn't exist.
// In the app: keeps the UI's generated types (pnpm api:types) and agents' docs honest about what the server answers.
// Used by: `go test ./internal/httpapi/...`.
// Uses: GET /api (the router's own list) and api/openapi.yaml, read as text (path and method lines only).

package httpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

var (
	contractPath   = regexp.MustCompile(`^  (/\S*):\s*$`)
	contractMethod = regexp.MustCompile(`^    (get|put|post|patch|delete):\s*$`)
)

func TestRoutesMatchTheContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var documented []string
	current := ""
	for _, line := range strings.Split(string(raw), "\n") {
		if match := contractPath.FindStringSubmatch(line); match != nil {
			current = match[1]
			continue
		}
		if match := contractMethod.FindStringSubmatch(line); match != nil && strings.HasPrefix(current, "/api") {
			documented = append(documented, strings.ToUpper(match[1])+" "+current)
		}
	}

	r := newRig(t).enroll()
	var index struct {
		Endpoints []string `json:"endpoints"`
	}
	if err := json.Unmarshal(r.must(http.StatusOK, call{path: "/api"}).body, &index); err != nil {
		t.Fatal(err)
	}
	if len(documented) == 0 || len(index.Endpoints) == 0 {
		t.Fatalf("nothing to compare: %d documented, %d served", len(documented), len(index.Endpoints))
	}
	slices.Sort(documented)
	served := slices.Sorted(slices.Values(index.Endpoints))
	for _, route := range served {
		if !slices.Contains(documented, route) {
			t.Errorf("served but not in api/openapi.yaml: %s", route)
		}
	}
	for _, route := range documented {
		if !slices.Contains(served, route) {
			t.Errorf("in api/openapi.yaml but not served: %s", route)
		}
	}
}
