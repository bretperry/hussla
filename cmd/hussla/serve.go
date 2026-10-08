// The composition root: takes the data-directory lock, opens storage, builds the use-cases, and serves the two listeners until a signal.
// In the app: everything `hussla serve` does between start and stop.
// Used by: main.go.
// Uses: every adapter (sqlite, tailnet, passkey, filestore, signinfile, datadir) and every use-case; httpapi for the handlers.
//
// Start order is for speed and safety: lock first (a second process stops before touching
// anything), then storage, then the local listener (serving in well under a second), then the
// tailnet in the background (joining can wait on a login). Stop order is the reverse: stop taking
// requests, let the ones in flight finish (config.ShutdownGrace), close the tailnet, close storage,
// release the lock.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	hussla "github.com/bretperry/hussla"
	"github.com/bretperry/hussla/internal/adapters/datadir"
	"github.com/bretperry/hussla/internal/adapters/filestore"
	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/adapters/signinfile"
	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/adapters/tailnet"
	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
)

// appVersion is recorded with each migration; the release build sets it with -ldflags.
var appVersion = "dev"

// localAddressFile records the local listener's address, so `hussla open` finds the port.
const localAddressFile = "local-address"

// settings is the environment, read once.
type settings struct {
	dataDir   string
	hostname  string
	authKey   string
	tailnet   bool
	localPort string // "" for none
}

func settingsFrom(getenv func(string) string) settings {
	result := settings{dataDir: getenv("DATA_DIR"), hostname: getenv("HUSSLA_HOSTNAME"), authKey: getenv("TS_AUTHKEY"), tailnet: getenv("HUSSLA_TAILNET") != "off", localPort: getenv("HUSSLA_LOCAL_PORT")}
	if result.dataDir == "" {
		result.dataDir = "data"
	}
	if result.hostname == "" {
		result.hostname = "hussla"
	}
	switch result.localPort {
	case "":
		result.localPort = "8484"
	case "off":
		result.localPort = ""
	}
	return result
}

func serve(ctx context.Context, env settings, logOutput io.Writer) error {
	logger := slog.New(slog.NewTextHandler(logOutput, nil))
	slog.SetDefault(logger)
	dataDir, err := filepath.Abs(env.dataDir)
	if err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	lock, err := datadir.Acquire(dataDir)
	if err != nil {
		return err //nolint:wrapcheck // ErrLocked is matched by main for its exit code
	}
	defer func() { _ = lock.Release() }()

	storage, err := sqlite.Open(ctx, sqlite.Options{Dir: dataDir, AppVersion: appVersion})
	if err != nil {
		return fmt.Errorf("open storage: %w", err)
	}
	defer func() { _ = storage.Close() }()

	services, err := buildServices(dataDir, storage, logger)
	if err != nil {
		return err
	}
	if err := services.Auth.IssueSetupCode(ctx); err != nil {
		return fmt.Errorf("setup code: %w", err)
	}

	var servers []*http.Server
	var serving sync.WaitGroup
	start := func(name string, server *http.Server, listener net.Listener) {
		servers = append(servers, server)
		serving.Add(1)
		go func() {
			defer serving.Done()
			if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error("listener stopped", "listener", name, "error", err)
			}
		}()
	}

	if env.localPort != "" {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", env.localPort))
		if err != nil {
			return fmt.Errorf("local listener: %w", err)
		}
		port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
		handler := httpapi.New(httpapi.Config{Listener: httpapi.ListenerLocal, Hosts: []string{"localhost:" + port, "127.0.0.1:" + port}}, services)
		start("local", newServer(handler), listener)
		if err := os.WriteFile(filepath.Join(dataDir, localAddressFile), []byte("localhost:"+port), 0o600); err != nil {
			return fmt.Errorf("record local address: %w", err)
		}
		logger.Info("listening", "url", "http://localhost:"+port, "signin", "run `hussla open`")
	}

	var tailnetMutex sync.Mutex
	var tailnetNode *tailnet.Node
	if env.tailnet {
		go func() {
			node, err := tailnet.Start(ctx, tailnet.Options{DataDir: dataDir, Hostname: env.hostname, AuthKey: env.authKey, Logf: func(format string, args ...any) { logger.Info(fmt.Sprintf(format, args...)) }})
			if err != nil {
				logger.Error("tailnet", "error", err)
				return
			}
			tailnetMutex.Lock()
			tailnetNode = node
			tailnetMutex.Unlock()
			if adopted, err := services.Auth.AdoptNodeOwner(ctx, node.NodeOwner()); err != nil {
				logger.Error("owner", "error", err)
			} else if adopted {
				logger.Info("owner set to the tailnet user who owns this node", "login", node.NodeOwner().Login)
			}
			if err := services.Auth.IssueSetupCode(ctx); err != nil {
				logger.Error("setup code", "error", err)
			}
			listener, err := node.Listener()
			if err != nil {
				logger.Error("tailnet listener", "error", err)
				return
			}
			handler := httpapi.New(httpapi.Config{Listener: httpapi.ListenerTailnet, Hosts: []string{node.Domain()}, Peers: node}, services)
			tailnetMutex.Lock()
			defer tailnetMutex.Unlock()
			if ctx.Err() != nil { // stopping already: don't start a server nobody will shut down
				_ = listener.Close()
				return
			}
			start("tailnet", newServer(handler), listener)
			logger.Info("listening", "url", "https://"+node.Domain())
		}()
	}

	var backups sync.WaitGroup
	backups.Add(1)
	go func() {
		defer backups.Done()
		dailyBackups(ctx, storage, logger)
	}()

	<-ctx.Done()
	logger.Info("stopping: finishing requests in flight")
	shutdown, cancel := context.WithTimeout(context.Background(), config.ShutdownGrace)
	defer cancel()
	tailnetMutex.Lock()
	for _, server := range servers {
		if err := server.Shutdown(shutdown); err != nil {
			logger.Warn("shutdown", "error", err)
		}
	}
	tailnetMutex.Unlock()
	serving.Wait()
	backups.Wait() // a backup in progress finishes before storage closes
	tailnetMutex.Lock()
	if tailnetNode != nil {
		_ = tailnetNode.Close()
	}
	tailnetMutex.Unlock()
	_ = os.Remove(filepath.Join(dataDir, localAddressFile))
	logger.Info("stopped")
	return nil
}

func newServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
}

func buildServices(dataDir string, storage *sqlite.Store, logger *slog.Logger) (httpapi.Deps, error) {
	blobs, err := filestore.NewBlobs(filepath.Join(dataDir, "files"))
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("files: %w", err)
	}
	resumes, err := filestore.NewResumes(filepath.Join(dataDir, "resumes"))
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("résumés: %w", err)
	}
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("mail time zone: %w", err)
	}
	ui, err := fs.Sub(webApp, "web")
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("web app: %w", err)
	}
	return httpapi.Deps{
		Auth: auth.New(auth.Options{
			Store: storage, Ceremony: passkey.Ceremony{}, SignIn: signinfile.New(dataDir),
			AnnounceSetupCode: func(code string) {
				logger.Warn("SETUP CODE: enter it on the setup screen to claim this install and add your passkey", "code", code)
			},
		}),
		Tracker:     tracker.New(storage, nil),
		Mail:        mailbox.New(mailbox.Options{Store: storage, Location: location}),
		Attachments: attachments.New(storage, blobs, resumes, config.UploadMaxBytes, nil),
		AgentsGuide: hussla.AgentsGuide,
		UI:          ui,
	}, nil
}

// dailyBackups makes the daily backup now and whenever a day has passed, while the server runs.
func dailyBackups(ctx context.Context, storage *sqlite.Store, logger *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if made, err := storage.BackupDaily(ctx); err != nil {
			logger.Error("daily backup", "error", err)
		} else if made {
			logger.Info("daily backup made")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
