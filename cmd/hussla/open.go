// `hussla open`: signs this computer's browser in to the running server through a one-time link.
// In the app: a laptop without Tailscale; Docker Desktop users run it with `docker exec`.
// Used by: main.go.
// Uses: the running server's <DATA_DIR>/local-address, and signinfile.Write for the token.
//
// The link carries a token that works once, for config.SignInTokenLifetime. Only someone who can
// write the data directory can make one, and loopback alone grants nothing.

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/adapters/signinfile"
)

func openBrowser(env settings, args []string, stdout io.Writer) error {
	address, err := os.ReadFile(filepath.Join(env.dataDir, localAddressFile))
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("no Hussla is serving this data directory on this computer (start it first, with the local listener on)")
	}
	if err != nil {
		return fmt.Errorf("find the server: %w", err)
	}
	token, err := signinfile.Write(env.dataDir, time.Now())
	if err != nil {
		return err //nolint:wrapcheck // already says what failed
	}
	link := "http://" + strings.TrimSpace(string(address)) + "/signin?t=" + token
	if slices.Contains(args, "--print") || os.Getenv("HUSSLA_NO_BROWSER") != "" {
		_, err := fmt.Fprintln(stdout, link)
		return err //nolint:wrapcheck // a failed write to stdout
	}
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", link)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", link)
	default:
		command = exec.Command("xdg-open", link)
	}
	if err := command.Start(); err != nil {
		_, _ = fmt.Fprintln(stdout, "Open this link in your browser (it works once, for two minutes):", link)
		return nil
	}
	_, _ = fmt.Fprintln(stdout, "Opened your browser. The link works once, for two minutes.")
	return nil
}
