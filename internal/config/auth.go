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
// listener) may try before that caller is locked out for SetupCodeLockout. The code itself stays the
// same, so someone else's wrong guesses can't make the owner's code stale.
const SetupCodeAttempts = 5

// SetupCodeLockout is how long a caller who ran out of SetupCodeAttempts waits before trying again.
// Five tries per quarter hour against a 60-bit code is no guessing at all.
const SetupCodeLockout = 15 * time.Minute

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
