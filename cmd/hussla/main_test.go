// Lifecycle tests on the real binary: a clean stop that finishes the request in flight, a fast restart, and one process per data directory.
// In the app: the NAS restarting the container, a laptop lid closing, a second copy started by mistake.
// Used by: `go test ./cmd/hussla/` (pnpm go:test, CI).
// Uses: `go build` of this package into a temp dir; the local listener only (HUSSLA_TAILNET=off), so no tailnet is touched.

package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// buildBinary compiles hussla once per test run.
var buildBinary = sync.OnceValues(func() (string, error) {
	dir, err := os.MkdirTemp("", "hussla-bin-")
	if err != nil {
		return "", err
	}
	binary := filepath.Join(dir, "hussla")
	output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput()
	if err != nil {
		return "", errors.New(string(output))
	}
	return binary, nil
})

// server is one running hussla process.
type server struct {
	command *exec.Cmd
	log     *lockedBuffer
	base    string
	exited  chan struct{} // closed when the process has exited; then exitErr is set
	exitErr error
}

type lockedBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

func environment(dataDir string) []string {
	return append(os.Environ(), "DATA_DIR="+dataDir, "HUSSLA_TAILNET=off", "HUSSLA_LOCAL_PORT=0", "HUSSLA_NO_BROWSER=1")
}

// start runs hussla on dataDir and waits until it answers; it returns how long that took.
func start(t *testing.T, dataDir string) (*server, time.Duration) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("signals and the lock are exercised on Unix; Windows builds are cross-compiled only")
	}
	binary, err := buildBinary()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	running := &server{command: exec.Command(binary, "serve"), log: &lockedBuffer{}, exited: make(chan struct{})}
	running.command.Env = environment(dataDir)
	running.command.Stdout, running.command.Stderr = running.log, running.log
	began := time.Now()
	if err := running.command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		running.exitErr = running.command.Wait()
		close(running.exited)
	}()
	t.Cleanup(func() {
		_ = running.command.Process.Kill()
		<-running.exited
	})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if address, err := os.ReadFile(filepath.Join(dataDir, localAddressFile)); err == nil {
			running.base = "http://" + strings.TrimSpace(string(address))
			if response, err := http.Get(running.base + "/healthz"); err == nil {
				_ = response.Body.Close()
				if response.StatusCode == http.StatusOK {
					return running, time.Since(began)
				}
			}
		}
		select {
		case <-running.exited:
			t.Fatalf("hussla exited early (%v):\n%s", running.exitErr, running.log.String())
		case <-time.After(10 * time.Millisecond):
		}
	}
	t.Fatalf("hussla didn't start serving:\n%s", running.log.String())
	return nil, 0
}

// signIn runs `hussla open --print` and follows the link; the client keeps the session cookie.
func signIn(t *testing.T, dataDir string, base string) *http.Client {
	t.Helper()
	binary, _ := buildBinary()
	command := exec.Command(binary, "open", "--print")
	command.Env = environment(dataDir)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("hussla open: %v", err)
	}
	link := strings.TrimSpace(string(output))
	if !strings.HasPrefix(link, base+"/signin?t=") {
		t.Fatalf("hussla open printed %q", link)
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	response, err := client.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK { // after the redirect to the app
		t.Fatalf("sign-in: %d", response.StatusCode)
	}
	return client
}

func send(t *testing.T, client *http.Client, method, url, origin, contentType string, body io.Reader) (int, string) {
	t.Helper()
	status, text, err := sendRaw(client, method, url, origin, contentType, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return status, text
}

// sendRaw is send for a goroutine other than the test's (which may not call t.Fatal).
func sendRaw(client *http.Client, method, url, origin, contentType string, body io.Reader) (int, string, error) {
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", contentType)
	response, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	return response.StatusCode, string(raw), err
}

func TestGracefulShutdownAndRestart(t *testing.T) {
	dataDir := t.TempDir()
	first, _ := start(t, dataDir)
	client := signIn(t, dataDir, first.base)
	status, body := send(t, client, http.MethodPost, first.base+"/api/jobs", first.base, "application/json", strings.NewReader(`{"company":"Example Co","title":"Engineer"}`))
	if status != http.StatusCreated {
		t.Fatalf("create job: %d %s", status, body)
	}

	// A slow upload: half the bytes, then SIGTERM, then the rest. The stop must wait for it.
	reader, writer := io.Pipe()
	uploaded := make(chan string, 1)
	go func() {
		status, body, err := sendRaw(client, http.MethodPost, first.base+"/api/jobs/example-co-engineer/files?name=cover.pdf&kind=cover-letter", first.base, "application/pdf", reader)
		if err != nil {
			body = err.Error()
		}
		uploaded <- strings.Join([]string{http.StatusText(status), body}, " ")
	}()
	chunk := bytes.Repeat([]byte("synthetic "), 10_000)
	if _, err := writer.Write(chunk); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // the request is in the handler now
	if err := first.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := writer.Write(chunk); err != nil {
		t.Fatalf("the server stopped reading mid-upload: %v", err)
	}
	_ = writer.Close()
	if result := <-uploaded; !strings.HasPrefix(result, "Created") {
		t.Fatalf("upload in flight during SIGTERM: %s\n%s", result, first.log.String())
	}
	select {
	case <-first.exited:
		if first.exitErr != nil {
			t.Fatalf("exit after SIGTERM: %v\n%s", first.exitErr, first.log.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("still running 10s after SIGTERM:\n%s", first.log.String())
	}
	if _, err := os.Stat(filepath.Join(dataDir, localAddressFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the local-address file outlived the server: %v", err)
	}

	// Restart: serving in under a second, with the upload kept.
	second, took := start(t, dataDir)
	if took > time.Second {
		t.Errorf("restart took %v, want under 1s", took)
	}
	client = signIn(t, dataDir, second.base)
	status, body = send(t, client, http.MethodGet, second.base+"/api/jobs/example-co-engineer", "", "", nil)
	if status != http.StatusOK || !strings.Contains(body, "cover.pdf") {
		t.Fatalf("after restart: %d %s", status, body)
	}
}

func TestSecondProcessRefused(t *testing.T) {
	dataDir := t.TempDir()
	first, _ := start(t, dataDir)
	binary, _ := buildBinary()
	second := exec.Command(binary, "serve")
	second.Env = environment(dataDir)
	output, err := second.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != exitLocked {
		t.Fatalf("second process: %v, want exit %d:\n%s", err, exitLocked, output)
	}
	if !strings.Contains(string(output), "already running") {
		t.Fatalf("second process said: %s", output)
	}
	// The first is untouched.
	response, err := http.Get(first.base + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("first process after the second was refused: %d", response.StatusCode)
	}
}
