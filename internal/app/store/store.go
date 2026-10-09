// The storage port: one unit of work over every repository.
// In the app: every use-case that writes does its read, its rule and its write inside one Atomically call.
// Used by: the SQLite adapter and the in-memory fake (both implement Store); use-cases (Phases 3-4) take a Store.
// Uses: the repository ports in the sibling packages (jobs, companies, events, answers, files, tokens, settings, emails, pitches).
//
// Why a unit of work and not a transaction per repository: "a write and whatever it implies" (a
// job patch and its activity line, an email's approval and its event) must land together or not
// at all, so a kill between the two can't leave a change with no trace. Rules run inside the call
// on the values the repositories return, so a read-modify-write can't interleave with another.

package store

import (
	"context"

	"github.com/bretperry/hussla/internal/app/answers"
	"github.com/bretperry/hussla/internal/app/companies"
	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/pitches"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/tokens"
)

// Tx is the repositories of one unit of work. A Tx is valid only inside the function it was
// handed to; keeping it past the return is a bug.
type Tx interface {
	Jobs() jobs.Repository
	Companies() companies.Repository
	Events() events.Repository
	Answers() answers.Repository
	Files() files.Repository
	Tokens() tokens.Repository
	Settings() settings.Repository
	Emails() emails.Repository
	Pitches() pitches.Repository
}

// Store runs units of work. Both methods return what the function returned, wrapped only when the
// store itself failed.
type Store interface {
	// Atomically runs work and commits everything it wrote, or, when it returns an error (or
	// panics), commits nothing. Units of work run one at a time. The store's own failure (disk
	// full, closed) comes back as an error that is not one of the domain's.
	Atomically(ctx context.Context, work func(Tx) error) error
	// View runs work against a consistent snapshot and writes nothing: a write through its Tx fails.
	View(ctx context.Context, work func(Tx) error) error
}
