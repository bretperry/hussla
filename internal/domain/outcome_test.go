// Tests for classifying a remote's error into an Outcome.
// In the app: nothing at runtime; runs in `go test` on every PR (tier 1).
// Used by: go test.
// Uses: errors.go, outcome.go.

package domain_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"example.com/app/internal/domain"
)

func TestOutcomeOf(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		want   domain.Outcome
		wantOK bool
	}{
		{"no error: applied", nil, domain.OutcomeApplied, true},
		{"unreachable: transient", domain.ErrUnreachable, domain.OutcomeTransient, true},
		{"timeout: transient", context.DeadlineExceeded, domain.OutcomeTransient, true},
		{"5xx: transient", &domain.RemoteError{Status: 503}, domain.OutcomeTransient, true},
		{"4xx: refused", &domain.RemoteError{Status: 400}, domain.OutcomeRefused, true},
		{"wrapped 4xx is still refused", fmt.Errorf("put: %w", &domain.RemoteError{Status: 422}), domain.OutcomeRefused, true},
		{"a stranger is not classified", errors.New("nil map write"), domain.OutcomeTransient, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := domain.OutcomeOf(tt.err)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("OutcomeOf(%v) = (%v, %v), want (%v, %v)", tt.err, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}
