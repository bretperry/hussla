// Fakes of the auth ports: a tailnet that answers WhoIs from a table, and a sign-in token "file" in memory.
// In the app: nothing at runtime (tests only); no real tailnet and no data directory in tests.
// Used by: the HTTP tests (auth matrix, routes) and the auth use-case tests.
// Uses: the auth ports.

package fakeauth

import (
	"context"
	"sync"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
)

// Tailnet answers WhoIs from Peers, keyed by the connection's remote address ("100.64.0.1:40000").
// An address not in the table is auth.ErrUnknownPeer, like a connection from off the tailnet.
type Tailnet struct {
	mutex sync.Mutex
	peers map[string]auth.TailnetPeer
	// Calls counts WhoIs calls, so a test can prove an agent key never consults the tailnet.
	Calls int
}

var _ auth.PeerIdentifier = (*Tailnet)(nil)

// NewTailnet returns an empty tailnet.
func NewTailnet() *Tailnet { return &Tailnet{peers: map[string]auth.TailnetPeer{}} }

// Add puts a peer at an address.
func (t *Tailnet) Add(remoteAddr string, peer auth.TailnetPeer) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	t.peers[remoteAddr] = peer
}

// WhoIs implements auth.PeerIdentifier.
func (t *Tailnet) WhoIs(_ context.Context, remoteAddr string) (auth.TailnetPeer, error) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	t.Calls++
	peer, found := t.peers[remoteAddr]
	if !found {
		return auth.TailnetPeer{}, auth.ErrUnknownPeer
	}
	return peer, nil
}

// SignInTokens is the token file in memory. Removals counts how often it was removed.
type SignInTokens struct {
	mutex    sync.Mutex
	token    *auth.SignInToken
	Removals int
}

var _ auth.SignInTokens = (*SignInTokens)(nil)

// Put leaves a token, as `hussla open` would.
func (s *SignInTokens) Put(secret string, expires time.Time) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.token = &auth.SignInToken{Secret: secret, ExpiresAt: expires}
}

// Read implements auth.SignInTokens.
func (s *SignInTokens) Read(context.Context) (auth.SignInToken, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.token == nil {
		return auth.SignInToken{}, auth.ErrNoSignInToken
	}
	return *s.token, nil
}

// Remove implements auth.SignInTokens.
func (s *SignInTokens) Remove(context.Context) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.token = nil
	s.Removals++
	return nil
}

// Clock is a settable time source.
type Clock struct {
	mutex sync.Mutex
	at    time.Time
}

// NewClock starts at a fixed instant.
func NewClock(at time.Time) *Clock { return &Clock{at: at} }

// Now is the clock's time.
func (c *Clock) Now() time.Time {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.at
}

// Advance moves the clock on.
func (c *Clock) Advance(by time.Duration) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.at = c.at.Add(by)
}
