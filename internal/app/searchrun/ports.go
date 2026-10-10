// The search-run port: Firer starts the owner's Claude job-search routine, and the errors a fire can end in.
// In the app: the Search now button on the Jobs page.
// Used by: Service, internal/adapters/routinefire (the real Firer), internal/httpapi (maps the errors).
// Uses: mailsetup.Secret for the routine's token (redacted in every print and log).

package searchrun

import (
	"context"
	"errors"

	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// Fired is what the routine's endpoint answered: the cloud session the run lives in.
type Fired struct {
	// SessionURL is where the owner watches the run (https://claude.ai/code/…); empty when the reply had none.
	SessionURL string
}

// Firer starts one run of a routine. Errors: ErrTokenRejected, ErrRoutineNotFound, ErrRateLimited,
// or a *FireError whose Reason is safe to show.
type Firer interface {
	Fire(ctx context.Context, routineID string, token mailsetup.Secret, text string) (Fired, error)
}

// ErrNotConfigured: no routine or no token is saved yet.
var ErrNotConfigured = errors.New("the search button isn't set up yet: add your routine in Settings → Job search")

// ErrTooSoon: a search started within config.SearchRunCooldown.
var ErrTooSoon = errors.New("a search started a few minutes ago; wait for it to finish before starting another")

// ErrTokenRejected: the routine's endpoint refused the token (revoked, regenerated, or pasted wrong).
var ErrTokenRejected = errors.New("the routine token was refused: generate a new one on the routine's page and save it in Settings → Job search")

// ErrRoutineNotFound: no routine has that id on the token's account.
var ErrRoutineNotFound = errors.New("no routine has that id on the token's account: check the routine URL in Settings → Job search")

// ErrRateLimited: the routine or the account hit its hourly fire limit.
var ErrRateLimited = errors.New("the hourly limit for starting this routine is used up; try again later")

// FireError is any other failed fire; Reason names what happened, never the token.
type FireError struct {
	Reason string
}

func (fireError *FireError) Error() string { return fireError.Reason }
