// The Unix half of the data-directory lock: flock(LOCK_EX|LOCK_NB).
// In the app: Linux NAS containers and macOS laptops.
// Used by: lock.go.

//go:build unix

package datadir

import (
	"fmt"
	"os"
	"syscall"
)

func lockFile(file *os.File) error {
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("flock: %w", err)
	}
	return nil
}

func unlockFile(file *os.File) {
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
