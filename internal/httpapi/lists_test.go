// A job or company whose lists were never set answers [] for each, as the contract types them, never null.
// In the app: the UI crashed on a fresh company ("t.reviews is null", a blank page) on the first NAS install.
// Used by: `go test ./internal/httpapi/...`.

package httpapi_test

import (
	"net/http"
	"testing"
)

func TestUnsetListsAnswerEmptyArrays(t *testing.T) {
	r := newRig(t).enroll()
	jobID := r.newJob("Engineer")

	job := r.must(http.StatusOK, call{path: "/api/jobs/" + jobID, origin: tailnetOrigin}).json(t)
	for _, key := range []string{"reasons", "scamFlags", "contacts", "sources"} {
		if list, ok := job[key].([]any); !ok || len(list) != 0 {
			t.Errorf("job %s = %#v, want []", key, job[key])
		}
	}

	slug, _ := job["companySlug"].(string)
	company := r.must(http.StatusOK, call{path: "/api/companies/" + slug, origin: tailnetOrigin}).json(t)
	for _, key := range []string{"facts", "anecdotes", "news", "reviews", "sources"} {
		if list, ok := company[key].([]any); !ok || len(list) != 0 {
			t.Errorf("company %s = %#v, want []", key, company[key])
		}
	}
}
