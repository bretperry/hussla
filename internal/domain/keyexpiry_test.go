// Key-expiry warnings against a fixed clock: no warning far out, a warning inside the window, expired after.
// In the app: the key-expiry banner.
// Used by: `go test ./internal/domain/`.

package domain_test

import (
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

func TestKeyExpiryWarnsAheadOfTime(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		expires  time.Time
		warn     bool
		expired  bool
		daysLeft int
	}{
		{"expiry off", time.Time{}, false, false, 0},
		{"months away", now.Add(180 * 24 * time.Hour), false, false, 180},
		{"just outside the window", now.Add(config.KeyExpiryWarnAhead + time.Minute), false, false, 14},
		{"just inside the window", now.Add(config.KeyExpiryWarnAhead - time.Minute), true, false, 13},
		{"last day", now.Add(3 * time.Hour), true, false, 0},
		{"expired", now.Add(-time.Minute), true, true, 0},
	}
	for _, test := range cases {
		got := domain.KeyExpiryAt(now, test.expires)
		if got.Warn != test.warn || got.Expired != test.expired || got.DaysLeft != test.daysLeft {
			t.Errorf("%s: got %+v, want warn=%v expired=%v days=%d", test.name, got, test.warn, test.expired, test.daysLeft)
		}
	}
}
