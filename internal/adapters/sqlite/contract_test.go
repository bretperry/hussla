package sqlite_test

import (
	"testing"

	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/testsupport/storecontract"
)

// openTemp opens a store on a fresh temp directory and closes it when the test ends.
func openTemp(t testing.TB) *sqlite.Store {
	t.Helper()
	opened, err := sqlite.Open(t.Context(), sqlite.Options{Dir: t.TempDir(), AppVersion: "test"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() {
		if err := opened.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return opened
}

func TestSQLiteStoreMeetsTheStorageContract(t *testing.T) {
	storecontract.Run(t, func(t *testing.T) store.Store { return openTemp(t) })
}
