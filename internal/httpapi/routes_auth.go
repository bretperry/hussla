// Setup, sign-in and passkey routes: the setup code, `hussla open`'s sign-in link, passkey registration and step-up.
// In the app: the "enter setup code" screen, the first-run "add a passkey" step, every passkey prompt, Settings → sign out everywhere.
// Used by: server.go's route table.
//
// The browser half of a passkey prompt: POST /api/stepup/begin {method, path} → options for
// navigator.credentials.get; POST /api/stepup/finish {challengeId, credential} → {token}; then the
// owner-only request carries the token in X-Hussla-Step-Up. The token is good once, for that
// method and path only, for config.StepUpLifetime.

package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/domain"
)

func (server *api) setupStatus(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	status, err := server.deps.Auth.Status(r.Context(), server.relyingParty(r))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	listener := "tailnet"
	if server.config.Listener == ListenerLocal {
		listener = "local"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enrolled": status.Enrolled, "passkeys": status.Passkeys, "codeInLog": status.CodeLive,
		"listener": listener, "isOwner": caller.IsOwner(),
	})
	return nil
}

func (server *api) setupClaim(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input struct {
		Code string `json:"code"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	switch caller.Role() {
	case auth.RoleNone:
		return auth.ErrUnauthorized
	case auth.RoleAgent:
		return auth.ErrNotOwner
	case auth.RolePeer, auth.RoleOwner:
	}
	_, token, err := server.deps.Auth.Claim(r.Context(), caller, input.Code)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, map[string]string{"stepUp": token, "next": auth.PurposeRegisterPasskey})
	return nil
}

func (server *api) signIn(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	if server.config.Listener != ListenerLocal {
		writeError(w, http.StatusNotFound, errorBody{Error: "sign-in links work only on this computer's local address"})
		return nil
	}
	secret, expires, err := server.deps.Auth.SignIn(r.Context(), r.URL.Query().Get("t"))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: secret, Path: "/", Expires: expires,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: server.scheme == "https",
	})
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/", http.StatusSeeOther)
	return nil
}

func (server *api) signOutEverywhere(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	if err := server.deps.Auth.SignOutEverywhere(r.Context(), caller); err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

func (server *api) listPasskeys(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	list, err := server.deps.Auth.Passkeys(r.Context(), caller)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	encoded := make([]map[string]any, 0, len(list))
	for _, passkey := range list {
		encoded = append(encoded, map[string]any{
			"id": passkey.ID, "name": passkey.Name, "rpId": passkey.RPID, "createdAt": moment(passkey.CreatedAt), "lastUsedAt": moment(passkey.LastUsedAt),
		})
	}
	writeJSON(w, http.StatusOK, encoded)
	return nil
}

type challengeBody struct {
	ChallengeID string          `json:"challengeId"`
	Options     json.RawMessage `json:"options"`
}

func (server *api) registerBegin(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	id, options, err := server.deps.Auth.BeginRegistration(r.Context(), caller, server.relyingParty(r))
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, challengeBody{ChallengeID: id, Options: options})
	return nil
}

type ceremonyAnswer struct {
	ChallengeID string          `json:"challengeId"`
	Name        string          `json:"name"`
	Credential  json.RawMessage `json:"credential"`
}

func (server *api) registerFinish(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input ceremonyAnswer
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	stored, err := server.deps.Auth.FinishRegistration(r.Context(), caller, server.relyingParty(r), input.ChallengeID, input.Name, input.Credential)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": stored.ID, "name": stored.Name, "rpId": stored.RPID})
	return nil
}

func (server *api) stepUpBegin(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" || !strings.HasPrefix(input.Path, "/") {
		return &domain.ValidationError{Field: "path", Problem: `name the action to confirm, like {"method":"POST","path":"/api/emails/e1/approve"}`}
	}
	id, options, err := server.deps.Auth.BeginStepUp(r.Context(), caller, server.relyingParty(r), method+" "+input.Path)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, challengeBody{ChallengeID: id, Options: options})
	return nil
}

func (server *api) stepUpFinish(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input ceremonyAnswer
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	token, expires, err := server.deps.Auth.FinishStepUp(r.Context(), caller, server.relyingParty(r), input.ChallengeID, input.Credential)
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expiresAt": moment(expires)})
	return nil
}
