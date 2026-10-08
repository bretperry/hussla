// Error mapping: SQLite's constraint failures as the storage errors use-cases test for.
// In the app: a second create of the same id becomes storeerr.ErrExists, never a driver message.
// Used by: every repository file in this package.
// Uses: modernc.org/sqlite's error type, internal/app/storeerr.

package sqlite

import (
	"errors"

	sqlitedriver "modernc.org/sqlite"
)

// Extended result codes for a violated PRIMARY KEY and UNIQUE constraint (sqlite.org/rescode.html).
const (
	resultConstraintPrimaryKey = 1555
	resultConstraintUnique     = 2067
)

// isUniqueViolation is true when err is a duplicate primary key or unique value.
func isUniqueViolation(err error) bool {
	var driverError *sqlitedriver.Error
	if !errors.As(err, &driverError) {
		return false
	}
	code := driverError.Code()
	return code == resultConstraintPrimaryKey || code == resultConstraintUnique
}
