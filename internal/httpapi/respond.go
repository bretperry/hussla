// JSON in and out, and the one mapping from a use-case's error to a status code and a body.
// In the app: every API response and every refusal an agent or the UI acts on.
// Used by: every route file in this package.
//
// An error nobody mapped is a 500 with a generic message: its text goes to the log only, so a
// storage path or a provider's reply never reaches a client.

package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// errorBody is the contract's Error schema.
type errorBody struct {
	Error  string   `json:"error"`
	Code   string   `json:"code,omitempty"`
	Fields []string `json:"fields,omitempty"`
}

// Stable codes a client acts on (the contract's Error.code enum).
const (
	codeOwnerField       = "owner-field"
	codeChangedSinceRead = "changed-since-read"
	codeTransition       = "transition-not-allowed"
	codeSetupRequired    = "setup-required"
	codePasskeyRequired  = "passkey-required"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, body errorBody) {
	writeJSON(w, status, body)
}

// statusFor maps an error to its status and body.
func statusFor(err error) (int, errorBody) {
	var validation *domain.ValidationError
	var ownerFields *domain.OwnerFieldsError
	var tooLarge *http.MaxBytesError
	var fireError *searchrun.FireError
	switch {
	case errors.As(err, &validation):
		return http.StatusBadRequest, errorBody{Error: validation.Error()}
	case errors.As(err, &ownerFields):
		return http.StatusConflict, errorBody{Error: ownerFields.Error(), Code: codeOwnerField, Fields: ownerFields.Fields}
	case errors.Is(err, domain.ErrChangedSinceRead), errors.Is(err, storeerr.ErrConflict):
		return http.StatusConflict, errorBody{Error: "changed since you read it: review it again", Code: codeChangedSinceRead}
	case errors.Is(err, domain.ErrTransitionNotAllowed):
		return http.StatusConflict, errorBody{Error: rootMessage(err), Code: codeTransition}
	case errors.Is(err, storeerr.ErrNotFound):
		return http.StatusNotFound, errorBody{Error: "not found"}
	case errors.Is(err, storeerr.ErrExists):
		return http.StatusConflict, errorBody{Error: "already exists"}
	case errors.Is(err, auth.ErrUnauthorized), errors.Is(err, auth.ErrSignInRefused):
		return http.StatusUnauthorized, errorBody{Error: rootMessage(err)}
	case errors.Is(err, auth.ErrNotEnrolled):
		return http.StatusForbidden, errorBody{Error: auth.ErrNotEnrolled.Error(), Code: codeSetupRequired}
	case errors.Is(err, auth.ErrStepUpRequired):
		return http.StatusForbidden, errorBody{Error: auth.ErrStepUpRequired.Error(), Code: codePasskeyRequired}
	case errors.Is(err, domain.ErrOwnerOnly):
		return http.StatusForbidden, errorBody{Error: auth.ErrNotOwner.Error()}
	case errors.Is(err, tracker.ErrNoFreePitchSlot):
		return http.StatusConflict, errorBody{Error: tracker.ErrNoFreePitchSlot.Error()}
	case errors.Is(err, auth.ErrNotOwner), errors.Is(err, mailbox.ErrAgentMayNot),
		errors.Is(err, auth.ErrPasskeyRejected), errors.Is(err, auth.ErrWrongSetupCode), errors.Is(err, auth.ErrSetupCodeLocked), errors.Is(err, auth.ErrWrongLink),
		errors.Is(err, auth.ErrFirstRunPasskeyLimited):
		return http.StatusForbidden, errorBody{Error: rootMessage(err)}
	case errors.Is(err, auth.ErrChallengeUnknown):
		return http.StatusBadRequest, errorBody{Error: auth.ErrChallengeUnknown.Error()}
	case errors.Is(err, auth.ErrNoPasskey), errors.Is(err, auth.ErrSetupClosed), errors.Is(err, auth.ErrFirstRunClosed),
		errors.Is(err, auth.ErrStartOverClosed), errors.Is(err, auth.ErrLastPasskey), errors.Is(err, setup.ErrNoTailnet),
		errors.Is(err, setup.ErrNotMismatched), errors.Is(err, setup.ErrNotReady):
		return http.StatusConflict, errorBody{Error: rootMessage(err)}
	case errors.Is(err, auth.ErrCodeTooSoon):
		return http.StatusTooManyRequests, errorBody{Error: auth.ErrCodeTooSoon.Error()}
	case errors.Is(err, auth.ErrTooManyCodes):
		return http.StatusTooManyRequests, errorBody{Error: auth.ErrTooManyCodes.Error()}
	case errors.Is(err, mailsetup.ErrNotConfigured):
		return http.StatusBadRequest, errorBody{Error: mailbox.ErrMailNotConfigured.Error()}
	case errors.Is(err, mailbox.ErrMailNotConfigured):
		return http.StatusBadRequest, errorBody{Error: mailbox.ErrMailNotConfigured.Error()}
	case errors.Is(err, searchrun.ErrNotConfigured):
		return http.StatusBadRequest, errorBody{Error: searchrun.ErrNotConfigured.Error()}
	case errors.Is(err, searchrun.ErrTooSoon):
		return http.StatusTooManyRequests, errorBody{Error: searchrun.ErrTooSoon.Error()}
	case errors.Is(err, searchrun.ErrRateLimited):
		return http.StatusTooManyRequests, errorBody{Error: searchrun.ErrRateLimited.Error()}
	case errors.Is(err, searchrun.ErrTokenRejected), errors.Is(err, searchrun.ErrRoutineNotFound):
		return http.StatusBadGateway, errorBody{Error: rootMessage(err)}
	case errors.As(err, &fireError) && fireError.MaybeStarted:
		return http.StatusBadGateway, errorBody{Error: "the search may have started (" + fireError.Reason + "): check your routine's runs at claude.ai/code/routines before trying again"}
	case errors.As(err, &fireError):
		return http.StatusBadGateway, errorBody{Error: "the search didn't start: " + fireError.Reason}
	case errors.Is(err, attachments.ErrTooLarge), errors.As(err, &tooLarge):
		return http.StatusRequestEntityTooLarge, errorBody{Error: "the body is over the size limit"}
	}
	return http.StatusInternalServerError, errorBody{Error: "something went wrong on the server; see its log"}
}

// rootMessage is the message of the sentinel at the bottom of a wrapped chain (no internal context).
func rootMessage(err error) string {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err.Error()
		}
		err = next
	}
}

func fail(w http.ResponseWriter, r *http.Request, err error) {
	status, body := statusFor(err)
	if status == http.StatusInternalServerError {
		slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
	}
	writeError(w, status, body)
}

// readObject reads a JSON object body (capped).
func readObject(r *http.Request) (wire.Object, error) {
	raw, err := readBody(r, config.RequestBodyMaxBytes)
	if err != nil {
		return nil, err
	}
	return wire.ParseObject(raw) //nolint:wrapcheck // a ValidationError for the 400 mapping
}

// readBody reads the whole body up to limit bytes.
func readBody(r *http.Request, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, err //nolint:wrapcheck // the 413 mapping reads it
		}
		return nil, &domain.ValidationError{Field: "(body)", Problem: "couldn't be read"}
	}
	return raw, nil
}

// decodeInto reads a JSON body into a typed struct (unknown keys ignored).
func decodeInto(r *http.Request, target any) error {
	raw, err := readBody(r, config.RequestBodyMaxBytes)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return &domain.ValidationError{Field: "(body)", Problem: "must be a JSON object of the documented shape"}
	}
	return nil
}
