// Storage errors: the failures every repository returns, as values a caller tests with errors.Is.
// In the app: the HTTP layer maps them (not found, already exists, changed since read) to status codes.
// Used by: every repository port, the SQLite adapter, the in-memory fake, use-cases.
//
// A leaf package so each repository port can name them without importing the others.

package storeerr

import "errors"

var (
	// ErrNotFound: the record asked for, updated or deleted isn't there.
	ErrNotFound = errors.New("not found")
	// ErrExists: a create named an id (or a unique value) that is already taken.
	ErrExists = errors.New("already exists")
	// ErrConflict: a conditional update found the row no longer in the state the caller read
	// (an email approved twice, a send claimed by someone else). The caller re-reads and decides.
	ErrConflict = errors.New("changed since it was read")
)
