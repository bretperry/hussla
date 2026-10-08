// Forward-only migrations, embedded in the binary, with a backup first and a refusal to downgrade.
// In the app: every start. A fresh data directory gets the whole schema; the prototype's database is adopted and upgraded in place.
// Used by: Open in store.go.
// Uses: migrations/*.sql (numbered 0001_name.sql, applied in order, each in its own transaction), backup.go.
//
// Rules: a migration never changes once released (add a new file); the applied versions must be
// an unbroken run from 1; a database ahead of this binary is refused with the build to run
// instead; and before applying anything to a database that holds data, a verified backup is made.

package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/bretperry/hussla/internal/domain"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	version int
	name    string
	script  string
}

// DowngradeError means the data was written by a newer build than this one.
type DowngradeError struct {
	DataVersion  int    // the schema version in the file
	KnownVersion int    // the newest this binary can handle
	WrittenBy    string // the app version that applied DataVersion, when recorded
}

func (downgrade *DowngradeError) Error() string {
	advice := "run a newer Hussla"
	if downgrade.WrittenBy != "" {
		advice = "run Hussla " + downgrade.WrittenBy + " or newer"
	}
	return fmt.Sprintf("this data is at schema version %d but this build only knows up to %d: %s (this build would damage it, so it stopped)",
		downgrade.DataVersion, downgrade.KnownVersion, advice)
}

// loadMigrations reads the embedded files, in version order, and checks they run 1, 2, 3 …
func loadMigrations() ([]migration, error) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	var migrations []migration
	for _, entry := range entries {
		name := entry.Name()
		number, _, found := strings.Cut(name, "_")
		version, convErr := strconv.Atoi(number)
		if !found || convErr != nil || !strings.HasSuffix(name, ".sql") {
			return nil, fmt.Errorf("migration file %q isn't named NNNN_name.sql", name)
		}
		script, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", name, err)
		}
		migrations = append(migrations, migration{version: version, name: strings.TrimSuffix(name, ".sql"), script: string(script)})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].version < migrations[j].version })
	for index, m := range migrations {
		if m.version != index+1 {
			return nil, fmt.Errorf("migration versions must run 1, 2, 3 …; found %s at position %d", m.name, index+1)
		}
	}
	return migrations, nil
}

// migrate brings the database to the newest schema.
func (s *Store) migrate(ctx context.Context) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		appliedAt TEXT NOT NULL,
		appVersion TEXT NOT NULL DEFAULT ''
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	applied, writtenBy, err := s.appliedVersions(ctx)
	if err != nil {
		return err
	}
	if len(applied) > len(migrations) {
		return &DowngradeError{DataVersion: len(applied), KnownVersion: len(migrations), WrittenBy: writtenBy}
	}
	for index, version := range applied {
		if version != index+1 {
			return fmt.Errorf("schema_migrations has a gap (version %d where %d should be): the database is damaged, restore a backup", version, index+1)
		}
	}
	pending := migrations[len(applied):]
	if len(pending) == 0 {
		return nil
	}
	hasData, err := s.hasTable(ctx, "jobs")
	if err != nil {
		return err
	}
	if hasData {
		if _, err := s.Backup(ctx, "pre-migrate"); err != nil {
			return fmt.Errorf("back up before migrating (nothing was changed): %w", err)
		}
	}
	for _, m := range pending {
		if err := s.apply(ctx, m, len(applied) == 0 && hasData); err != nil {
			return err
		}
	}
	return nil
}

// appliedVersions lists the applied schema versions in order, and the app version that applied the newest.
func (s *Store) appliedVersions(ctx context.Context) (versions []int, writtenBy string, err error) {
	rows, err := s.db.QueryContext(ctx, `SELECT version, appVersion FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, "", fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close() //nolint:errcheck // a read-only cursor; Err below reports what matters
	for rows.Next() {
		var version int
		if err := rows.Scan(&version, &writtenBy); err != nil {
			return nil, "", fmt.Errorf("scan schema_migrations: %w", err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("read schema_migrations: %w", err)
	}
	return versions, writtenBy, nil
}

func (s *Store) hasTable(ctx context.Context, name string) (bool, error) {
	var found string
	err := s.db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("look for table %s: %w", name, err)
	}
	return true, nil
}

// apply runs one migration and records it, in one transaction: both happen or neither does.
// adoptPrototype is true for the first migration on a database the prototype built.
func (s *Store) apply(ctx context.Context, m migration, adoptPrototype bool) error {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", m.name, err)
	}
	if err := runMigration(ctx, transaction, m, adoptPrototype, s.appVersion, domain.FormatTimestamp(s.now())); err != nil {
		if rollbackErr := transaction.Rollback(); rollbackErr != nil {
			return errors.Join(err, fmt.Errorf("rollback: %w", rollbackErr))
		}
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", m.name, err)
	}
	return nil
}

func runMigration(ctx context.Context, transaction *sql.Tx, m migration, adoptPrototype bool, appVersion, appliedAt string) error {
	if adoptPrototype && m.version == 1 {
		if err := adoptPrototypeEmails(ctx, transaction); err != nil {
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, m.script); err != nil {
		return fmt.Errorf("migration %s: %w", m.name, err)
	}
	if _, err := transaction.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, name, appliedAt, appVersion) VALUES (?, ?, ?, ?)`,
		m.version, m.name, appliedAt, appVersion); err != nil {
		return fmt.Errorf("record migration %s: %w", m.name, err)
	}
	return nil
}

// adoptPrototypeEmails adds the one column the prototype added late (emails.companySlug) to a
// prototype file that predates it; the baseline's IF NOT EXISTS would otherwise leave it out.
func adoptPrototypeEmails(ctx context.Context, transaction *sql.Tx) error {
	rows, err := transaction.QueryContext(ctx, `SELECT name FROM pragma_table_info('emails')`)
	if err != nil {
		return fmt.Errorf("read emails columns: %w", err)
	}
	hasCompanySlug, tableFound := false, false
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			return errors.Join(fmt.Errorf("scan emails columns: %w", err), rows.Close())
		}
		tableFound = true
		hasCompanySlug = hasCompanySlug || column == "companySlug"
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close emails columns: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read emails columns: %w", err)
	}
	if tableFound && !hasCompanySlug {
		if _, err := transaction.ExecContext(ctx, `ALTER TABLE emails ADD COLUMN companySlug TEXT`); err != nil {
			return fmt.Errorf("add emails.companySlug: %w", err)
		}
	}
	return nil
}
