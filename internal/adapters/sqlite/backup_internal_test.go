package sqlite

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
)

// An internal test: it needs the unexported hook that cuts a backup off between "copy made" and "copy published".
func TestBackupInterruptedMidwayNeverReplacesAGoodOne(t *testing.T) {
	now := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	opened, err := Open(t.Context(), Options{Dir: t.TempDir(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = opened.Close() }) //nolint:errcheck // test cleanup
	if err := opened.Atomically(t.Context(), func(tx store.Tx) error { return tx.Settings().Set(t.Context(), "k", "v") }); err != nil {
		t.Fatal(err)
	}

	// Fill the folder with the maximum number of good backups.
	var good []string
	for range 7 {
		now = now.Add(time.Hour)
		path, err := opened.Backup(t.Context(), "daily")
		if err != nil {
			t.Fatalf("backup: %v", err)
		}
		good = append(good, path)
	}
	contents := map[string][]byte{}
	for _, path := range good {
		contents[path], _ = os.ReadFile(path) //nolint:errcheck // compared below
	}

	// A backup cut off after the copy is made: nothing new is published, nothing old is pruned or touched.
	errCut := errors.New("power cut")
	opened.failBackupBeforeRename = func() error { return errCut }
	now = now.Add(time.Hour)
	if _, err := opened.Backup(t.Context(), "daily"); !errors.Is(err, errCut) {
		t.Fatalf("want the cut-off error, got %v", err)
	}
	opened.failBackupBeforeRename = nil
	assertBackups(t, opened.BackupDir(), good, contents)

	// A killed backup leaves a half-written temporary file; it is ignored, cleaned up by the next backup, and never counted as good.
	leftover := filepath.Join(opened.BackupDir(), "hussla-20261001T000000.000Z-daily.db.tmp")
	if err := os.WriteFile(leftover, []byte("half a backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := listBackups(opened.BackupDir()); len(got) != 7 {
		t.Fatalf("a temporary file must not count as a backup: %d listed", len(got))
	}
	now = now.Add(time.Hour)
	newest, err := opened.Backup(t.Context(), "daily")
	if err != nil {
		t.Fatalf("backup after a leftover: %v", err)
	}
	if _, err := os.Stat(leftover); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the leftover temporary file should be removed: %v", err)
	}
	entries, _ := os.ReadDir(opened.BackupDir())
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Errorf("temporary file left behind: %s", entry.Name())
		}
	}
	if got := listBackups(opened.BackupDir()); len(got) != 7 || got[0].path != newest {
		t.Errorf("after a good backup the oldest is pruned and the newest leads: %d, %v", len(got), got[0].path)
	}
}

func assertBackups(t *testing.T, dir string, want []string, contents map[string][]byte) {
	t.Helper()
	got := listBackups(dir)
	if len(got) != len(want) {
		t.Fatalf("backups changed: %d now, %d before", len(got), len(want))
	}
	for _, path := range want {
		now, err := os.ReadFile(path) //nolint:gosec // test path
		if err != nil || string(now) != string(contents[path]) {
			t.Fatalf("good backup %s was altered or removed: %v", path, err)
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("a cut-off backup must clean up its temporary file: %s", entry.Name())
		}
	}
}
