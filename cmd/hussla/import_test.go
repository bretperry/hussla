// Tests for `hussla import <file>`: the old tracker's export into a fresh data folder, twice, and refused under a running server.
// In the app: the terminal path of the move from the prototype.
// Used by: `go test ./cmd/hussla/` (pnpm go:test, CI).
// Uses: docs/reference/prototype/export-sample.json (synthetic), run() in-process, and the real binary for the lock case.

package main

import (
	"bytes"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var exportSamplePath = filepath.Join("..", "..", "docs", "reference", "prototype", "export-sample.json")

func runImport(t *testing.T, dataDir string, args ...string) (int, string, string) {
	t.Helper()
	getenv := func(name string) string {
		if name == "DATA_DIR" {
			return dataDir
		}
		return ""
	}
	var stdout, stderr bytes.Buffer
	code := run(append([]string{"import"}, args...), getenv, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestImportCommandTwiceAddsNothing(t *testing.T) {
	dataDir := t.TempDir()
	code, first, stderr := runImport(t, dataDir, exportSamplePath)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	for _, want := range []string{"jobs            4 (0)", "emails          5 (0)", "secrets are never imported", "never sent", `status "ghosted" has no match`} {
		if !strings.Contains(first, want) {
			t.Errorf("first run's output is missing %q:\n%s", want, first)
		}
	}
	code, second, stderr := runImport(t, dataDir, exportSamplePath)
	if code != 0 {
		t.Fatalf("second run: exit %d: %s", code, stderr)
	}
	for _, want := range []string{"jobs            0 (4)", "emails          0 (5)", "activity lines  0 (4)"} {
		if !strings.Contains(second, want) {
			t.Errorf("second run's output is missing %q:\n%s", want, second)
		}
	}
}

func TestImportCommandUsage(t *testing.T) {
	if code, _, stderr := runImport(t, t.TempDir()); code != 2 || !strings.Contains(stderr, "usage: hussla import") {
		t.Errorf("no file: exit %d, %s", code, stderr)
	}
	if code, _, stderr := runImport(t, t.TempDir(), filepath.Join(t.TempDir(), "missing.json")); code != 1 || !strings.Contains(stderr, "open the file") {
		t.Errorf("missing file: exit %d, %s", code, stderr)
	}
}

func TestImportCommandWaitsForARunningServer(t *testing.T) {
	dataDir := t.TempDir()
	start(t, dataDir)
	binary, _ := buildBinary()
	command := exec.Command(binary, "import", exportSamplePath)
	command.Env = environment(dataDir)
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != exitLocked {
		t.Fatalf("import under a running server: %v, want exit %d:\n%s", err, exitLocked, output)
	}
	if !strings.Contains(string(output), "Settings → Import from the old tracker") {
		t.Errorf("it must point to the Settings page: %s", output)
	}
}
