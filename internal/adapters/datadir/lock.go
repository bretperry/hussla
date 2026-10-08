// One process per data directory: an exclusive, non-blocking OS lock on <DATA_DIR>/hussla.lock.
// In the app: a second `hussla` started on the same data (a second container, a double-clicked binary) refuses to start.
// Used by: cmd/hussla, before the database opens.
// Uses: flock (lock_unix.go), LockFileEx (lock_windows.go).
//
// Why a lock and not a PID file: the OS drops the lock when the process dies by any means (kill -9,
// a power cut), so there is no stale file to clean up and no window where two dispatchers both send.

package datadir

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LockFileName is the lock's file name in the data directory.
const LockFileName = "hussla.lock"

// ErrLocked: another process holds the data directory.
var ErrLocked = errors.New("another Hussla is already running on this data directory")

// Lock is a held lock; Release frees it (exiting does too).
type Lock struct {
	file *os.File
}

// Acquire takes the lock on dir (created 0700 when missing), or returns ErrLocked at once.
func Acquire(dir string) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("data directory: %w", err)
	}
	path := filepath.Join(dir, LockFileName)
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock %s: %w", path, err)
	}
	if err := lockFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("%w (%s): %w", ErrLocked, path, err)
	}
	return &Lock{file: file}, nil
}

// Release frees the lock.
func (lock *Lock) Release() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	unlockFile(lock.file)
	err := lock.file.Close()
	lock.file = nil
	if err != nil {
		return fmt.Errorf("release lock: %w", err)
	}
	return nil
}
