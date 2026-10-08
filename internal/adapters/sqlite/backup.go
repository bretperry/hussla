// Backups and the integrity check: safe copies of the database, and a refusal to serve a damaged one.
// In the app: a copy before every migration and one a day; at start, a damaged file stops the server and names the latest backup.
// Used by: store.go (Open), migrate.go (before migrating), the composition root's daily tick (Phase 3).
// Uses: VACUUM INTO (a consistent copy while the database is in use), config.BackupsKept and config.BackupInterval.
//
// A backup is built under a temporary name, integrity-checked, flushed to disk, and only then
// renamed into place; pruning to the newest few runs after that. So a backup cut off at any point
// (crash, full disk, a damaged copy) leaves every earlier good backup exactly as it was.
// The install guides tell the owner to copy the backups folder off the device: a backup beside
// the database does not survive losing the device.

package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/config"
)

// backupNamePattern: hussla-<UTC time>-<reason>.db, so names sort oldest to newest.
var backupNamePattern = regexp.MustCompile(`^hussla-(\d{8}T\d{6}\.\d{3}Z)-([a-z-]+)\.db$`)

const backupTimeLayout = "20060102T150405.000Z"

// ReasonDaily is the reason of the scheduled backup.
const ReasonDaily = "daily"

// CorruptError means the database file failed its integrity check; LatestBackup is where to
// restore from ("" when there is none).
type CorruptError struct {
	Path         string
	Problem      string
	LatestBackup string
}

func (corrupt *CorruptError) Error() string {
	message := fmt.Sprintf("the database %s is damaged (%s); Hussla will not serve it", corrupt.Path, corrupt.Problem)
	if corrupt.LatestBackup != "" {
		return message + ". The latest automatic backup is " + corrupt.LatestBackup + ": stop Hussla, copy it over the database file, and start again"
	}
	return message + ", and there is no automatic backup yet: restore a copy you made yourself"
}

// checkIntegrity runs SQLite's integrity check; anything but "ok" (or a file that can't be read as a database) is a CorruptError.
func (s *Store) checkIntegrity(ctx context.Context, path string) error {
	problem, err := integrityProblem(ctx, s.db)
	if err == nil && problem == "" {
		return nil
	}
	if err != nil {
		problem = err.Error()
	}
	return &CorruptError{Path: path, Problem: problem, LatestBackup: s.latestBackup()}
}

// integrityProblem is "" for a healthy database, else the first line SQLite complained about.
func integrityProblem(ctx context.Context, db *sql.DB) (string, error) {
	var first string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&first); err != nil {
		return "", fmt.Errorf("integrity check: %w", err)
	}
	if first == "ok" {
		return "", nil
	}
	return first, nil
}

// Backup makes a verified copy of the database under BackupDir and prunes old ones. reason is a
// short lowercase word ("daily", "pre-migrate"). It returns the new backup's path.
func (s *Store) Backup(ctx context.Context, reason string) (string, error) {
	if !regexp.MustCompile(`^[a-z-]+$`).MatchString(reason) {
		return "", fmt.Errorf("backup reason %q must be lowercase letters and hyphens", reason)
	}
	dir := s.BackupDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create backup directory: %w", err)
	}
	if err := removeLeftovers(dir); err != nil {
		return "", err
	}
	name := fmt.Sprintf("hussla-%s-%s.db", s.now().UTC().Format(backupTimeLayout), reason)
	final := filepath.Join(dir, name)
	temporary := final + ".tmp"
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, temporary); err != nil {
		return "", errors.Join(fmt.Errorf("copy database: %w", err), removeQuietly(temporary))
	}
	if err := verifyCopy(ctx, temporary); err != nil {
		return "", errors.Join(err, removeQuietly(temporary))
	}
	if s.failBackupBeforeRename != nil {
		if err := s.failBackupBeforeRename(); err != nil {
			return "", errors.Join(err, removeQuietly(temporary))
		}
	}
	if err := os.Rename(temporary, final); err != nil {
		return "", errors.Join(fmt.Errorf("publish backup: %w", err), removeQuietly(temporary))
	}
	syncDirectory(dir)
	if err := pruneBackups(dir, config.BackupsKept); err != nil {
		return final, err
	}
	return final, nil
}

// BackupDaily makes a "daily" backup unless one is newer than config.BackupInterval. made is
// true when it did.
func (s *Store) BackupDaily(ctx context.Context) (made bool, err error) {
	for _, backup := range listBackups(s.BackupDir()) {
		if backup.reason == ReasonDaily && s.now().Sub(backup.at) < config.BackupInterval {
			return false, nil
		}
	}
	if _, err := s.Backup(ctx, ReasonDaily); err != nil {
		return false, err
	}
	return true, nil
}

// verifyCopy opens the finished copy on its own, checks it, and flushes it to disk.
func verifyCopy(ctx context.Context, path string) error {
	copyDatabase, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: "mode=ro"}).String())
	if err != nil {
		return fmt.Errorf("open backup copy: %w", err)
	}
	copyDatabase.SetMaxOpenConns(1)
	problem, checkErr := integrityProblem(ctx, copyDatabase)
	if closeErr := copyDatabase.Close(); closeErr != nil && checkErr == nil {
		checkErr = fmt.Errorf("close backup copy: %w", closeErr)
	}
	if checkErr != nil {
		return checkErr
	}
	if problem != "" {
		return fmt.Errorf("the backup copy failed its integrity check (%s)", problem)
	}
	file, err := os.Open(path) //nolint:gosec // path is built from our own backup directory
	if err != nil {
		return fmt.Errorf("open backup copy to flush: %w", err)
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		return fmt.Errorf("flush backup copy: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close backup copy: %w", closeErr)
	}
	return nil
}

// syncDirectory flushes a directory entry (the rename) to disk. Best effort: not every platform allows it.
func syncDirectory(dir string) {
	directory, err := os.Open(dir) //nolint:gosec // our own backup directory
	if err != nil {
		return
	}
	_ = directory.Sync()  //nolint:errcheck // best effort, see above
	_ = directory.Close() //nolint:errcheck // read-only handle
}

func removeQuietly(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}

// removeLeftovers deletes temporary files an earlier, interrupted backup left; they are never a good backup.
func removeLeftovers(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read backup directory: %w", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".db.tmp") {
			if err := removeQuietly(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

type backupFile struct {
	path   string
	at     time.Time
	reason string
}

// listBackups returns the published backups, newest first. Temporary files and strangers are ignored.
func listBackups(dir string) []backupFile {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var backups []backupFile
	for _, entry := range entries {
		match := backupNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		at, err := time.Parse(backupTimeLayout, match[1])
		if err != nil {
			continue
		}
		backups = append(backups, backupFile{path: filepath.Join(dir, entry.Name()), at: at, reason: match[2]})
	}
	sort.Slice(backups, func(i, j int) bool { return backups[i].path > backups[j].path })
	return backups
}

func (s *Store) latestBackup() string {
	if backups := listBackups(s.BackupDir()); len(backups) > 0 {
		return backups[0].path
	}
	return ""
}

// pruneBackups keeps the newest `keep` published backups. It runs only after a new one was
// verified and published, so it never trades a good backup for nothing.
func pruneBackups(dir string, keep int) error {
	backups := listBackups(dir)
	if len(backups) <= keep {
		return nil
	}
	for _, old := range backups[keep:] {
		if err := removeQuietly(old.path); err != nil {
			return err
		}
	}
	return nil
}
