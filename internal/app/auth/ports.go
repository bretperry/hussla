// The auth ports: the tailnet's answer to "who is on the other end", the sign-in token file, and the passkey ceremony.
// In the app: every request's identity, `hussla open`, the setup screen and every owner-only action's passkey tap.
// Used by: auth.Service; implemented by internal/adapters/tailnet, internal/adapters/signinfile, internal/adapters/passkey;
// faked in internal/testsupport (no real tailnet or authenticator in tests).
//
// The passkey port speaks opaque bytes (options JSON for the browser, a session blob between the two
// halves of a ceremony, a credential blob to store) so the WebAuthn library stays in the adapter and
// this layer keeps only the rules: who may start a ceremony, for what, and how long it lives.

package auth

import (
	"context"
	"errors"
	"time"
)

// TailnetPeer is the tailnet's account of a connection's far end. UserID is stable; Login and
// Name are for display. Tagged peers (servers, CI) belong to no user and are never the owner.
type TailnetPeer struct {
	UserID string
	Login  string
	Name   string
	Tagged bool
}

// PeerIdentifier answers WhoIs for a connection's remote address. Only the tailnet adapter
// implements it, from the connection itself: no header is ever consulted.
type PeerIdentifier interface {
	// WhoIs returns the peer behind remoteAddr ("100.x.y.z:port"), or ErrUnknownPeer.
	WhoIs(ctx context.Context, remoteAddr string) (TailnetPeer, error)
}

// ErrUnknownPeer: the tailnet doesn't know the address (not a tailnet connection).
var ErrUnknownPeer = errors.New("unknown tailnet peer")

// SignInToken is the one-time token `hussla open` leaves in the data directory.
type SignInToken struct {
	Secret    string
	ExpiresAt time.Time
}

// SignInTokens reads and removes the token file.
type SignInTokens interface {
	// Read returns the current token, or ErrNoSignInToken when there is none (or it is unreadable or unsafe).
	Read(ctx context.Context) (SignInToken, error)
	// Remove deletes the token so it can't be used twice.
	Remove(ctx context.Context) error
}

// ErrNoSignInToken: no usable token file.
var ErrNoSignInToken = errors.New("no sign-in token")

// RelyingParty is the site a passkey belongs to: ID is the host name ("hussla.tail1234.ts.net",
// "localhost"), Origin the exact origin the browser reports ("https://hussla.tail1234.ts.net").
type RelyingParty struct {
	ID     string
	Origin string
}

// PasskeyUser is the owner as the authenticator knows them: a random handle and a display name.
type PasskeyUser struct {
	Handle []byte
	Name   string
}

// StoredPasskey is one registered credential. ID is the credential id (base64url); Credential is
// the adapter's own record (public key, sign count), opaque here.
type StoredPasskey struct {
	ID         string    `json:"id"`
	RPID       string    `json:"rpId"`
	Name       string    `json:"name"`
	Credential []byte    `json:"credential"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
}

// Ceremony runs the WebAuthn halves. Begin* return the options for navigator.credentials and a
// session blob; Finish* check the browser's response against that blob and return the
// credential's id and its (new) stored record. A response that doesn't verify is ErrPasskeyRejected.
type Ceremony interface {
	BeginRegistration(rp RelyingParty, user PasskeyUser, existing []StoredPasskey) (options, session []byte, err error)
	FinishRegistration(rp RelyingParty, user PasskeyUser, session, response []byte) (id string, credential []byte, err error)
	BeginAssertion(rp RelyingParty, user PasskeyUser, passkeys []StoredPasskey) (options, session []byte, err error)
	FinishAssertion(rp RelyingParty, user PasskeyUser, passkeys []StoredPasskey, session, response []byte) (id string, credential []byte, err error)
}
