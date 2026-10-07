// Unit and property tests for the note merge rule.
// In the app: nothing at runtime; runs in `go test` on every PR (tier 1).
// Used by: go test.
// Uses: pgregory.net/rapid (property tests; a failing run prints the seed to replay it).

package domain_test

import (
	"testing"
	"time"

	"pgregory.net/rapid"

	"example.com/app/internal/config"
	"example.com/app/internal/domain"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func TestMerge(t *testing.T) {
	older := domain.Note{ID: "n", Text: "older", ComposedAt: epoch}
	newer := domain.Note{ID: "n", Text: "newer", ComposedAt: epoch.Add(time.Minute)}
	tie := domain.Note{ID: "n", Text: "tie", ComposedAt: epoch}

	tests := []struct {
		name     string
		stored   *domain.Note
		incoming domain.Note
		want     string
	}{
		{"nothing stored: incoming", nil, older, "older"},
		{"later incoming wins", &older, newer, "newer"},
		{"earlier incoming loses", &newer, older, "newer"},
		{"a tie goes to incoming", &older, tie, "tie"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := domain.Merge(tt.stored, tt.incoming).Text; got != tt.want {
				t.Fatalf("Merge() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestClampComposedAt(t *testing.T) {
	now := epoch
	tests := []struct {
		name string
		at   time.Time
		want time.Time
	}{
		{"within tolerance: kept", now.Add(config.MaxComposeSkewAhead), now.Add(config.MaxComposeSkewAhead)},
		{"an hour fast: the server's clock", now.Add(time.Hour), now},
		{"in the past: kept", now.Add(-time.Hour), now.Add(-time.Hour)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := domain.ClampComposedAt(tt.at, now, config.MaxComposeSkewAhead); !got.Equal(tt.want) {
				t.Fatalf("ClampComposedAt() = %v, want %v", got, tt.want)
			}
		})
	}
}

func drawNote(t *rapid.T, label string) domain.Note {
	return domain.Note{
		ID:         "n",
		Text:       rapid.String().Draw(t, label+"Text"),
		ComposedAt: epoch.Add(time.Duration(rapid.Int64Range(-1e12, 1e12).Draw(t, label+"At"))),
	}
}

func TestAcceptWriteProperties(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		stored := drawNote(t, "stored")
		incoming := drawNote(t, "incoming")
		got := domain.AcceptWrite(&stored, incoming, epoch)

		// A stamp never lands further ahead of the server than the tolerance, whatever the device said.
		if got.ComposedAt.After(epoch.Add(config.MaxComposeSkewAhead)) && got.ComposedAt.After(stored.ComposedAt) {
			t.Fatalf("stamp %v is past the tolerance and not the stored one", got.ComposedAt)
		}
		// The stored stamp never goes backwards.
		if got.ComposedAt.Before(stored.ComposedAt) {
			t.Fatalf("stamp went back: %v < %v", got.ComposedAt, stored.ComposedAt)
		}
		// Applying the same write again changes nothing more (a retry is a no-op).
		if again := domain.AcceptWrite(&got, incoming, epoch); again != got {
			t.Fatalf("second apply changed the note: %v -> %v", got, again)
		}
	})
}
