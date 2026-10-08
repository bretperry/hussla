// Domain errors: the expected failures a rule can return, as values a caller can test for.
// In the app: the HTTP layer maps ValidationError to 400 and ErrTransitionNotAllowed to 409.
// Used by: every rule in this package; internal/httpapi (Phase 3) for the status codes.

package domain

import (
	"errors"
	"fmt"
)

// ValidationError says which field of an input is wrong and why, in words the owner or an agent can act on.
type ValidationError struct {
	Field   string
	Problem string
}

func (validationError *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", validationError.Field, validationError.Problem)
}

// ErrTransitionNotAllowed is returned when a state machine is asked for a move it doesn't declare
// (approving a sent email, editing one that is sending).
var ErrTransitionNotAllowed = errors.New("transition not allowed")

// invalid builds a ValidationError; a short form for the many field checks.
func invalid(field, problem string) error {
	return &ValidationError{Field: field, Problem: problem}
}
