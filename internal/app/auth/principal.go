// Who a request is: nobody, a tailnet user who isn't the owner, an agent key, or the owner.
// In the app: every route's first question; the activity log's actor; which writer a patch is.
// Used by: auth.Service (it builds them), internal/httpapi (it checks them), the record use-cases (Actor).
//
// A Principal is built only by this package, from a proof (a WhoIs answer, a session cookie, an
// agent key), so the HTTP layer can't promote a request by setting a field.

package auth

import (
	"errors"

	"github.com/bretperry/hussla/internal/domain"
)

// Role is what a principal may do.
type Role int

const (
	// RoleNone: no proof at all.
	RoleNone Role = iota
	// RolePeer: a tailnet user (or tagged device) that is not the owner. Only the setup screen.
	RolePeer
	// RoleAgent: a request with a valid agent key. Never the owner, whoever sends it.
	RoleAgent
	// RoleOwner: the owner's tailnet identity or the owner's local session.
	RoleOwner
)

// Principal is a proven caller. The zero Principal is RoleNone.
type Principal struct {
	role    Role
	name    string
	login   string
	keyID   string
	peer    TailnetPeer
	binding string // what challenges and step-up tokens are tied to
}

// Role is what this caller may do.
func (principal Principal) Role() Role { return principal.role }

// IsOwner is true only for the owner.
func (principal Principal) IsOwner() bool { return principal.role == RoleOwner }

// IsAgent is true only for an agent key.
func (principal Principal) IsAgent() bool { return principal.role == RoleAgent }

// Name is how the caller appears: the owner's display name, or the agent key's name.
func (principal Principal) Name() string { return principal.name }

// Login is the owner's tailnet login (empty for agents and local sessions without one).
func (principal Principal) Login() string { return principal.login }

// Peer is the tailnet peer behind a tailnet principal (zero otherwise).
func (principal Principal) Peer() TailnetPeer { return principal.peer }

// Actor is how the activity log names this caller ("Bret", "agent:laptop").
func (principal Principal) Actor() string {
	if principal.role == RoleAgent {
		return domain.AgentActor(principal.name)
	}
	return principal.name
}

// Writer is the patch writer this caller is: owner for the owner, agent for everyone else (fail closed).
func (principal Principal) Writer() domain.Writer {
	if principal.role == RoleOwner {
		return domain.WriterOwner
	}
	return domain.WriterAgent
}

// Errors the HTTP layer maps to status codes.
var (
	// ErrUnauthorized: no valid proof of identity (401).
	ErrUnauthorized = errors.New("not signed in")
	// ErrNotOwner: a proven caller who isn't the owner asked for the owner's action or data (403).
	ErrNotOwner = errors.New("only the owner can do this")
	// ErrNotEnrolled: nobody has claimed this install yet; only the setup screen works (403).
	ErrNotEnrolled = errors.New("this install has no owner yet: enter the setup code")
	// ErrStepUpRequired: an owner-only action needs a fresh passkey tap for exactly this action (403).
	ErrStepUpRequired = errors.New("confirm with your passkey first")
	// ErrNoPasskey: no passkey is registered here yet (409); finish setup first.
	ErrNoPasskey = errors.New("no passkey is registered for this address yet: finish setup with the setup code")
	// ErrPasskeyRejected: the authenticator's answer didn't verify (403).
	ErrPasskeyRejected = errors.New("the passkey answer didn't verify")
	// ErrChallengeUnknown: the passkey prompt expired, was used, or belongs to someone else (400).
	ErrChallengeUnknown = errors.New("that passkey prompt expired: start again")
	// ErrWrongSetupCode: the setup code is wrong (403).
	ErrWrongSetupCode = errors.New("that setup code is wrong")
	// ErrSetupCodeLocked: this caller made too many wrong guesses and waits config.SetupCodeLockout (403).
	ErrSetupCodeLocked = errors.New("too many wrong setup codes from this account: try again in a few minutes")
	// ErrSetupClosed: no setup code is active (409): setup is done, or a new code is in the log.
	ErrSetupClosed = errors.New("no setup code is active: check the log for a new one")
	// ErrSignInRefused: the sign-in token is wrong, used or expired (401).
	ErrSignInRefused = errors.New("that sign-in link is used or expired: run `hussla open` again")
)
