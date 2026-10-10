// Search now routes: the routine setup in Settings → Job search, and the button that starts a search.
// In the app: the Jobs page's Search now button and the Settings section that sets it up.
// Used by: server.go's route table (owner-only; saving needs a passkey tap, starting a search doesn't).
// Uses: internal/app/searchrun.
//
// Starting a search spends the owner's Claude usage, not their data, so one click is enough;
// the use-case's cooldown keeps a double click from starting two runs.

package httpapi

import (
	"net/http"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
)

// searchRoutineJSON is the contract's SearchRoutine.
type searchRoutineJSON struct {
	Configured     bool    `json:"configured"`
	RoutineID      string  `json:"routineId"`
	HasToken       bool    `json:"hasToken"`
	LastRunAt      *string `json:"lastRunAt"`
	LastSessionURL *string `json:"lastSessionUrl"`
}

func searchViewToJSON(view searchrun.View) searchRoutineJSON {
	return searchRoutineJSON{
		Configured: view.Configured(), RoutineID: view.RoutineID, HasToken: view.HasToken,
		LastRunAt: moment(view.LastRunAt), LastSessionURL: nullable(view.LastSessionURL),
	}
}

func (server *api) searchRoutine(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	if server.deps.Search == nil {
		writeJSON(w, http.StatusOK, searchViewToJSON(searchrun.View{}))
		return nil
	}
	view, err := server.deps.Search.View(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, searchViewToJSON(view))
	return nil
}

func (server *api) saveSearchRoutine(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if server.deps.Search == nil {
		return searchrun.ErrNotConfigured
	}
	var input struct {
		Routine string `json:"routine"`
		// Token is the routine's API trigger token; absent keeps the stored one (same routine only).
		Token *string `json:"token"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	save := searchrun.SaveInput{Routine: input.Routine}
	if input.Token != nil {
		token := mailsetup.NewSecret(*input.Token)
		save.Token = &token
	}
	view, err := server.deps.Search.Save(r.Context(), save, caller.Actor())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, searchViewToJSON(view))
	return nil
}

func (server *api) runSearch(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if server.deps.Search == nil {
		return searchrun.ErrNotConfigured
	}
	run, err := server.deps.Search.Run(r.Context(), caller.Actor())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, map[string]any{"startedAt": moment(run.StartedAt), "sessionUrl": nullable(run.SessionURL)})
	return nil
}
