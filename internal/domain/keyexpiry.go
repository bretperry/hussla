// When the node's Tailscale key runs out, and whether the owner should be warned yet.
// In the app: the banner that says "Hussla signs out of Tailscale in N days", and the wizard's key-expiry step.
// Used by: internal/app/setup.
// Uses: config.KeyExpiryWarnAhead.
//
// Why warn at all: a node logged in by a person (no auth key) gets a key that expires (about six
// months by default, inferred from Tailscale's admin defaults). When it does, Hussla drops off the
// tailnet and the phone can't reach it; disabling key expiry for the machine prevents that.

package domain

import (
	"time"

	"github.com/bretperry/hussla/internal/config"
)

// KeyExpiry is the warning state for one expiry time.
type KeyExpiry struct {
	At       time.Time // zero: the key doesn't expire (or it isn't known)
	DaysLeft int       // whole days until At, rounded down; 0 on the last day and after
	Warn     bool      // within config.KeyExpiryWarnAhead, or already expired
	Expired  bool
}

// KeyExpiryAt says how close expiresAt is to now. A zero expiresAt never warns.
func KeyExpiryAt(now, expiresAt time.Time) KeyExpiry {
	if expiresAt.IsZero() {
		return KeyExpiry{}
	}
	left := expiresAt.Sub(now)
	notice := KeyExpiry{At: expiresAt.UTC(), Expired: left <= 0, Warn: left <= config.KeyExpiryWarnAhead}
	if left > 0 {
		notice.DaysLeft = int(left / (24 * time.Hour))
	}
	return notice
}
