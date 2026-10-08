// The SQLite store: opens the database file, runs units of work, and hands each its repositories.
// In the app: the one database behind every page and agent call; the composition root opens it once at startup.
// Used by: cmd/hussla (Phase 3); implements store.Store from internal/app/store.
// Uses: modernc.org/sqlite (pure Go, no cgo), migrate.go, backup.go, the repository files beside this one.
//
// Crash safety, in one place: WAL journal and synchronous=FULL make a commit durable before
// Atomically returns, so a kill (lid closed, power cut) loses at most the request in flight, and
// every write plus what it implies is one transaction. The pool is one connection, so units of
// work run one at a time, which is what store.Store promises and all one person's traffic needs.
//
// Data directory layout (one-way choice, docs/plans/hussla-v1.md Phase 2): <dir>/hussla.db plus
// WAL files beside it, and <dir>/backups/ for the automatic backups.

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"

	// The driver, registered as "sqlite".
	_ "modernc.org/sqlite"
)

const (
	databaseFile = "hussla.db"
	backupFolder = "backups"
)

// Options say where the data lives and who is running.
type Options struct {
	Dir        string           // the data directory; created (0700) when missing
	AppVersion string           // recorded with each migration, so a downgrade can say what to run instead
	Now        func() time.Time // the clock; time.Now when nil
}

// Store is the SQLite implementation of store.Store.
type Store struct {
	db         *sql.DB
	dir        string
	appVersion string
	now        func() time.Time
	// failBackupBeforeRename lets a test cut a backup off after the copy is made and before it
	// is published; nil in production.
	failBackupBeforeRename func() error
}

var _ store.Store = (*Store)(nil)

// ErrReadOnly is what a write through a View's Tx returns.
var ErrReadOnly = errors.New("sqlite: write inside a read-only view")

// Open opens (creating if needed) the database in options.Dir, refuses a file that fails its
// integrity check or that a newer build wrote, backs up before migrating, and migrates.
func Open(ctx context.Context, options Options) (*Store, error) {
	if options.Dir == "" {
		return nil, errors.New("sqlite: no data directory")
	}
	if err := os.MkdirAll(filepath.Join(options.Dir, backupFolder), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	path := filepath.Join(options.Dir, databaseFile)
	existing := false
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		existing = true
	}
	db, err := sql.Open("sqlite", dataSourceName(path))
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	now := options.Now
	if now == nil {
		now = time.Now
	}
	opened := &Store{db: db, dir: options.Dir, appVersion: options.AppVersion, now: now}
	if existing {
		if err := opened.checkIntegrity(ctx, path); err != nil {
			return nil, closeAfter(db, err)
		}
	}
	if err := opened.migrate(ctx); err != nil {
		return nil, closeAfter(db, err)
	}
	return opened, nil
}

// closeAfter closes the database and returns the failure that made opening give up.
func closeAfter(db *sql.DB, cause error) error {
	if err := db.Close(); err != nil {
		return errors.Join(cause, fmt.Errorf("close: %w", err))
	}
	return cause
}

// dataSourceName turns a path into a driver DSN with the durability pragmas applied to every connection.
func dataSourceName(path string) string {
	query := url.Values{}
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", config.StorageBusyTimeout.Milliseconds()))
	query.Add("_pragma", "foreign_keys(ON)")
	// BEGIN IMMEDIATE: a unit of work takes the write lock up front instead of failing at its first write.
	query.Set("_txlock", "immediate")
	location := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: query.Encode()}
	return location.String()
}

// Close closes the database. Pending work must have returned.
func (s *Store) Close() error {
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("close database: %w", err)
	}
	return nil
}

// Path is the database file, for backups and messages.
func (s *Store) Path() string { return filepath.Join(s.dir, databaseFile) }

// BackupDir is where automatic backups are kept.
func (s *Store) BackupDir() string { return filepath.Join(s.dir, backupFolder) }

// Atomically runs work in one transaction: committed when it returns nil, rolled back when it
// returns an error or panics.
func (s *Store) Atomically(ctx context.Context, work func(store.Tx) error) error {
	return s.run(ctx, false, work)
}

// View runs work on a snapshot; writes through its Tx fail with ErrReadOnly.
func (s *Store) View(ctx context.Context, work func(store.Tx) error) error {
	return s.run(ctx, true, work)
}

func (s *Store) run(ctx context.Context, readOnly bool, work func(store.Tx) error) (err error) {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	finished := false
	defer func() {
		if finished {
			return
		}
		// A panic (or runtime.Goexit) in work: nothing is committed.
		if rollbackErr := transaction.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, fmt.Errorf("rollback: %w", rollbackErr))
		}
	}()
	unit := &unit{transaction: transaction, readOnly: readOnly}
	if workErr := work(unit); workErr != nil {
		finished = true
		if rollbackErr := transaction.Rollback(); rollbackErr != nil {
			return errors.Join(workErr, fmt.Errorf("rollback: %w", rollbackErr))
		}
		return workErr //nolint:wrapcheck // the caller's own error, returned exactly as the unit of work produced it
	}
	finished = true
	if readOnly {
		if err := transaction.Rollback(); err != nil {
			return fmt.Errorf("end view: %w", err)
		}
		return nil
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// unit is one transaction's repositories; it implements store.Tx.
type unit struct {
	transaction *sql.Tx
	readOnly    bool
}

var _ store.Tx = (*unit)(nil)

// exec runs a write; a View refuses it, so a read-only unit of work can't change anything.
func (u *unit) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if u.readOnly {
		return nil, ErrReadOnly
	}
	result, err := u.transaction.ExecContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}
	return result, nil
}

func (u *unit) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	rows, err := u.transaction.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	return rows, nil
}

func (u *unit) queryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return u.transaction.QueryRowContext(ctx, query, args...)
}

// timeArg is a time as stored: fixed-width UTC text, or NULL when unset.
func timeArg(moment time.Time) any {
	if moment.IsZero() {
		return nil
	}
	return domain.FormatTimestamp(moment)
}

// requiredTimeArg is for NOT NULL columns: an unset time is stored as empty text.
func requiredTimeArg(moment time.Time) string { return domain.FormatTimestamp(moment) }

// timeFrom reads a stored time. Rows the prototype wrote may carry a bare date or an odd offset;
// anything unreadable becomes "not set" rather than making the row unopenable.
func timeFrom(text sql.NullString) time.Time {
	if !text.Valid || text.String == "" {
		return time.Time{}
	}
	if moment, err := domain.ParseTimestamp(text.String); err == nil {
		return moment
	}
	if date, err := time.Parse(time.DateOnly, text.String); err == nil {
		return domain.NormalizeTime(date)
	}
	return time.Time{}
}
