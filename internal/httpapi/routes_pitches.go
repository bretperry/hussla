// Pitch routes: list, start, edit, add a version, pick the live one, delete a version or a pitch.
// In the app: the Pitches page and the front page billboard; agents add versions here (or through MCP).
// Used by: server.go (routes).
// Uses: the tracker's pitch use-cases, internal/app/wire/pitch.go (the one JSON shape both doors send).
//
// Who may: reading and adding a version are for members (owner or agent key); starting and editing a
// pitch are the owner's; picking the live version and deleting are the owner's with a passkey tap.
// The use-cases refuse an agent the owner's part too, so a route that lost its check still fails closed.

package httpapi

import (
	"net/http"
	"strconv"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// pathNumber reads a whole-number path value ({slot}, {version}); anything else is a 400 naming it.
func pathNumber(r *http.Request, name string) (int, error) {
	number, err := strconv.Atoi(r.PathValue(name))
	if err != nil {
		return 0, &domain.ValidationError{Field: name, Problem: "must be a whole number"}
	}
	return number, nil
}

func (server *api) listPitches(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	list, err := server.deps.Tracker.ListPitches(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, wire.PitchList(list))
	return nil
}

func (server *api) createPitch(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	object, err := readObject(r)
	if err != nil {
		return err
	}
	slot, title, when, first, err := wire.DecodeNewPitch(object)
	if err != nil {
		return err
	}
	pitch, err := server.deps.Tracker.CreatePitch(r.Context(), actorOf(caller), tracker.NewPitchInput{Slot: slot, Title: title, When: when, First: first})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, wire.PitchObject(pitch))
	return nil
}

func (server *api) patchPitch(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	slot, err := pathNumber(r, "slot")
	if err != nil {
		return err
	}
	object, err := readObject(r)
	if err != nil {
		return err
	}
	patch, err := wire.DecodePitchPatch(object)
	if err != nil {
		return err
	}
	pitch, err := server.deps.Tracker.PatchPitch(r.Context(), actorOf(caller), slot, patch)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, wire.PitchObject(pitch))
	return nil
}

func (server *api) addPitchVersion(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	slot, err := pathNumber(r, "slot")
	if err != nil {
		return err
	}
	object, err := readObject(r)
	if err != nil {
		return err
	}
	draft, err := wire.DecodePitchDraft(object)
	if err != nil {
		return err
	}
	pitch, _, err := server.deps.Tracker.AddPitchVersion(r.Context(), actorOf(caller), slot, draft)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, wire.PitchObject(pitch))
	return nil
}

func (server *api) setLivePitch(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	slot, err := pathNumber(r, "slot")
	if err != nil {
		return err
	}
	object, err := readObject(r)
	if err != nil {
		return err
	}
	number, err := wire.DecodePitchLive(object)
	if err != nil {
		return err //nolint:wrapcheck // a ValidationError for the 400 mapping
	}
	pitch, err := server.deps.Tracker.SetLivePitchVersion(r.Context(), actorOf(caller), slot, number)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, wire.PitchObject(pitch))
	return nil
}

func (server *api) deletePitchVersion(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	slot, err := pathNumber(r, "slot")
	if err != nil {
		return err
	}
	number, err := pathNumber(r, "version")
	if err != nil {
		return err
	}
	found, err := server.deps.Tracker.DeletePitchVersion(r.Context(), actorOf(caller), slot, number)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: found})
	return nil
}

func (server *api) deletePitch(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	slot, err := pathNumber(r, "slot")
	if err != nil {
		return err
	}
	found, err := server.deps.Tracker.DeletePitch(r.Context(), actorOf(caller), slot)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, okBody{OK: found})
	return nil
}
