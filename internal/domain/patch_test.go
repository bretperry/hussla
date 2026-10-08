// Tests for patch fields: the three states, and Apply for each.

package domain_test

import (
	"testing"

	"github.com/bretperry/hussla/internal/domain"
)

func TestFieldStates(t *testing.T) {
	var absent domain.Field[string]
	set := domain.Set("new")
	cleared := domain.Clear[string]()
	cases := []struct {
		name                          string
		field                         domain.Field[string]
		wantAbsent, wantSet, wantNull bool
		wantApplied                   string
	}{
		{"absent keeps", absent, true, false, false, "stored"},
		{"set replaces", set, false, true, false, "new"},
		{"null clears", cleared, false, false, true, ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			field := testCase.field
			if field.IsAbsent() != testCase.wantAbsent || field.IsSet() != testCase.wantSet || field.IsCleared() != testCase.wantNull {
				t.Fatalf("states = %v/%v/%v", field.IsAbsent(), field.IsSet(), field.IsCleared())
			}
			if got := field.Apply("stored"); got != testCase.wantApplied {
				t.Fatalf("Apply = %q, want %q", got, testCase.wantApplied)
			}
		})
	}
}
