// `hussla import <file>`: loads the old tracker's export (or a seed or backup file) into this install's data folder, then says what it did.
// In the app: the terminal path for the move from the prototype, for a laptop install or a stopped server; the NAS path is Settings → Import from the old tracker.
// Used by: main.go.
// Uses: internal/adapters/datadir (the same lock the server takes), internal/adapters/sqlite, internal/app/importseed.
//
// It takes the data-folder lock first, so it never writes under a running server: if Hussla is
// running it says to use the Settings page instead and exits 75 (try later). Existing records win
// and the whole file lands in one unit of work, so running it twice adds nothing.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/bretperry/hussla/internal/adapters/datadir"
	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/app/importseed"
	"github.com/bretperry/hussla/internal/config"
)

// errImportUsage is a missing or extra argument.
var errImportUsage = errors.New("usage: hussla import <file>   (the file you downloaded from the old tracker)")

func importFile(ctx context.Context, env settings, args []string, stdout io.Writer) error {
	if len(args) != 1 {
		return errImportUsage
	}
	input, err := os.Open(args[0])
	if err != nil {
		return fmt.Errorf("open the file: %w", err)
	}
	defer func() { _ = input.Close() }()

	dataDir, err := filepath.Abs(env.dataDir)
	if err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	lock, err := datadir.Acquire(dataDir)
	if err != nil {
		return err //nolint:wrapcheck // ErrLocked is matched by main for its exit code and message
	}
	defer func() { _ = lock.Release() }()
	storage, err := sqlite.Open(ctx, sqlite.Options{Dir: dataDir, AppVersion: config.Version})
	if err != nil {
		return fmt.Errorf("open storage: %w", err)
	}
	defer func() { _ = storage.Close() }()

	report, err := importseed.Import(ctx, storage, input, time.Now())
	if err != nil {
		return fmt.Errorf("import: %w", err)
	}
	printImportReport(stdout, report)
	return nil
}

// printImportReport is the report as a person reads it: what was added, what was already here, then what to know.
func printImportReport(out io.Writer, report importseed.Report) {
	_, _ = fmt.Fprintln(out, "Imported (already here, so left as is, in brackets):")
	for _, row := range []struct {
		name  string
		count importseed.Count
	}{
		{"companies", report.Companies},
		{"jobs", report.Jobs},
		{"answers", report.Answers},
		{"activity lines", report.Events},
		{"emails", report.Emails},
	} {
		_, _ = fmt.Fprintf(out, "  %-15s %d (%d)\n", row.name, row.count.Created, row.count.Skipped)
	}
	if report.ConfigStored {
		_, _ = fmt.Fprintln(out, "  search settings stored")
	}
	if len(report.Warnings) > 0 {
		_, _ = fmt.Fprintln(out, "\nWorth a look:")
		for _, warning := range report.Warnings {
			_, _ = fmt.Fprintln(out, "  - "+warning)
		}
	}
	_, _ = fmt.Fprintln(out, "\nGood to know:")
	for _, notice := range report.Notices {
		_, _ = fmt.Fprintln(out, "  - "+notice)
	}
}
