// Auth knobs: how long each proof of who you are lasts, and how many guesses a setup code allows.
// In the app: the setup-code screen, `hussla open` sign-in, passkey step-up before owner-only actions, agent keys.
// Used by: internal/app/auth; the HTTP layer's cookie lifetime.
// Uses: time.
//
// Why short: a step-up proves a finger was on the passkey just now, for one action; a sign-in
// token sits in a file anyone with the data directory can read, so it must die fast.

package config

import "time"

// SetupCodeAttempts is how many wrong setup codes one caller (one tailnet user, or the local
// listener) may try before that caller's further wrong guesses are refused for SetupCodeLockout.
// The right code always passes, locked or not (an agent sharing the owner's tailnet identity must
// not be able to lock the owner out), and the code itself stays the same.
const SetupCodeAttempts = 5

// SetupCodeLockout is how long a caller who ran out of SetupCodeAttempts has wrong guesses refused.
// It is a courtesy, not the defense: an 80-bit code is what makes guessing hopeless.
const SetupCodeLockout = 15 * time.Minute

// SetupCodesLive is how many printed setup codes can be good at once. A new code never
// invalidates one already printed (so nobody can make the code in the owner's log stale); once
// this many are live, asking for another is refused until a passkey spends them all.
const SetupCodesLive = 10

// StepUpLifetime is how long a passkey tap authorizes the one owner-only action it was made for.
const StepUpLifetime = 2 * time.Minute

// PasskeyChallengeLifetime is how long the browser has to answer a passkey prompt.
const PasskeyChallengeLifetime = 5 * time.Minute

// SignInTokenLifetime is how long the token `hussla open` writes stays usable (the plan says 2 minutes).
const SignInTokenLifetime = 2 * time.Minute

// SessionLifetime is how long a local-listener sign-in lasts before `hussla open` is needed again.
const SessionLifetime = 30 * 24 * time.Hour

// AgentKeyNameMaxLength caps an agent key's name; it shows in the activity log as agent:<name>.
const AgentKeyNameMaxLength = 80

// DefaultAgentKeyName is the name a key gets when the owner gives none.
const DefaultAgentKeyName = "agent"

// PasskeyNameMaxLength caps the label the owner gives a passkey ("iPhone", "MacBook").
const PasskeyNameMaxLength = 80

// UploadMaxBytes caps one attached file; a cover letter or screenshot is far below it.
const UploadMaxBytes = 25 << 20

// RequestBodyMaxBytes caps a JSON request body (an import bundle is the largest).
const RequestBodyMaxBytes = 8 << 20

// ShutdownGrace is how long a stopping server waits for requests in flight before it closes anyway.
const ShutdownGrace = 5 * time.Second
