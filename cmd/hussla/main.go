// The hussla binary: `hussla` (or `hussla serve`) runs the server; `hussla open` signs this computer's browser in; `hussla import <file>` loads the old tracker's export.
// In the app: the one process on the NAS or laptop; the Docker image's entrypoint (Phase 6).
// Used by: people and the Docker image; tests build and run it (main_test.go).
// Uses: serve.go (the composition root), open.go, import.go.
//
// Settings come from the environment, so the Docker screen on a NAS is the whole configuration:
//   DATA_DIR            where the database, backups, files and the tailnet state live (default ./data)
//   TS_AUTHKEY          a Tailscale auth key for the first join (later starts reuse the saved node)
//   HUSSLA_HOSTNAME     the node's tailnet name (default hussla → https://hussla.<tailnet>.ts.net)
//   HUSSLA_TAILNET      "off" to run without Tailscale (laptop, local listener only)
//   HUSSLA_LOCAL_PORT   the local listener's port on 127.0.0.1 (default 8484; "off" for none; 0 picks one)
//   HUSSLA_OWNER_LOGIN  your tailnet login (you@example.com); only it can claim the install

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/bretperry/hussla/internal/adapters/datadir"
)

// exitLocked is the exit code when another process holds the data directory (EX_TEMPFAIL: try later).
const exitLocked = 75

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
	}
	switch command {
	case "serve":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		err := serve(ctx, settingsFrom(getenv), stderr)
		if errors.Is(err, datadir.ErrLocked) {
			_, _ = fmt.Fprintln(stderr, "hussla:", err)
			return exitLocked
		}
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "hussla:", err)
			return 1
		}
		return 0
	case "open":
		if err := openBrowser(settingsFrom(getenv), args[1:], stdout); err != nil {
			_, _ = fmt.Fprintln(stderr, "hussla open:", err)
			return 1
		}
		return 0
	case "import":
		err := importFile(context.Background(), settingsFrom(getenv), args[1:], stdout)
		if errors.Is(err, datadir.ErrLocked) {
			_, _ = fmt.Fprintln(stderr, "hussla import: Hussla is running and holds the data folder. Import from the app instead (Settings → Import from the old tracker), or stop Hussla and run this again.")
			return exitLocked
		}
		if errors.Is(err, errImportUsage) {
			_, _ = fmt.Fprintln(stderr, err)
			return 2
		}
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "hussla import:", err)
			return 1
		}
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "usage: hussla [serve|open [--print]|import <file>]\n")
		return 2
	}
}
