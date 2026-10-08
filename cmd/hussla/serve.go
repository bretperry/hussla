// The composition root: takes the data-directory lock, opens storage, builds the use-cases, and serves the two listeners until a signal.
// In the app: everything `hussla serve` does between start and stop.
// Used by: main.go.
// Uses: every adapter (sqlite, tailnet, passkey, filestore, signinfile, datadir) and every use-case; httpapi for the handlers.
//
// Start order is for speed and safety: lock first (a second process stops before touching
// anything), then storage, then the local listener (serving in well under a second), then the
// tailnet in the background (joining can wait on a login, and retries until it works). Stop order is the reverse: stop taking
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
	dataDir    string
	hostname   string
	authKey    string
	tailnet    bool
	localPort  string // "" for none
	ownerLogin string // pins the owner's tailnet login; "" for anyone eligible
}

func settingsFrom(getenv func(string) string) settings {
	result := settings{dataDir: getenv("DATA_DIR"), hostname: getenv("HUSSLA_HOSTNAME"), authKey: getenv("TS_AUTHKEY"), tailnet: getenv("HUSSLA_TAILNET") != "off", localPort: getenv("HUSSLA_LOCAL_PORT"), ownerLogin: getenv("HUSSLA_OWNER_LOGIN")}
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

	services, err := buildServices(dataDir, storage, logger, env.ownerLogin)
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
		node := tailnet.New(tailnet.Options{DataDir: dataDir, Hostname: env.hostname, AuthKey: env.authKey, Logf: func(format string, args ...any) { logger.Info(fmt.Sprintf(format, args...)) }})
		tailnetNode = node
		go func() {
			listener, err := joinTailnet(ctx, node, logger)
			if err != nil {
				return // stopping
			}
			adoptNodeOwner(ctx, services.Auth, node.NodeOwner(), logger)
			if err := services.Auth.IssueSetupCode(ctx); err != nil {
				logger.Error("setup code", "error", err)
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

// tailnetJoiner is what joinTailnet needs from the tailnet node (a fake in tests).
type tailnetJoiner interface {
	Up(ctx context.Context) error
	Listener() (net.Listener, error)
}

// httpsHint is the one line a headless owner needs when the tailnet has no certificate for Hussla.
const httpsHint = "Tailnet HTTPS is off: turn on MagicDNS and HTTPS Certificates in the Tailscale admin console's DNS page (https://login.tailscale.com/admin/dns). Hussla keeps retrying and serves as soon as they are on."

// joinTailnet joins and opens the HTTPS listener, retrying with backoff (config.TailnetRetryFirst
// doubling to config.TailnetRetryMax) until both work or ctx ends. A headless server has nobody to
// restart it after the owner logs in or turns HTTPS on, so it never gives up. Each new problem is
// logged once; HTTPS off gets httpsHint.
func joinTailnet(ctx context.Context, node tailnetJoiner, logger *slog.Logger) (net.Listener, error) {
	wait := config.TailnetRetryFirst
	lastProblem := ""
	for {
		err := node.Up(ctx)
		if err == nil {
			listener, listenErr := node.Listener()
			if listenErr == nil {
				return listener, nil
			}
			err = listenErr
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("join the tailnet: %w", ctx.Err())
		}
		if problem := err.Error(); problem != lastProblem {
			lastProblem = problem
			if errors.Is(err, tailnet.ErrHTTPSOff) {
				logger.Warn(httpsHint)
			} else {
				logger.Error("tailnet: retrying", "error", err, "retryIn", wait.String())
			}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("join the tailnet: %w", ctx.Err())
		case <-time.After(wait):
		}
		wait = min(wait*2, config.TailnetRetryMax)
	}
}

// adoptNodeOwner makes the user who owns the node the owner when none is recorded, and says in one
// line when HUSSLA_OWNER_LOGIN is why it didn't (naming both logins; logins aren't secrets).
func adoptNodeOwner(ctx context.Context, authService *auth.Service, nodeOwner auth.TailnetPeer, logger *slog.Logger) {
	adopted, err := authService.AdoptNodeOwner(ctx, nodeOwner)
	switch {
	case err != nil:
		logger.Error("owner", "error", err)
	case adopted:
		logger.Info("owner set to the tailnet user who owns this node", "login", nodeOwner.Login)
	default:
		pinned, refuses := authService.PinRefuses(nodeOwner)
		if !refuses {
			return
		}
		if enrolled, err := authService.Enrolled(ctx); err != nil || enrolled {
			return
		}
		logger.Warn("HUSSLA_OWNER_LOGIN doesn't match the Tailscale login that owns this node, so nobody was made the owner: fix HUSSLA_OWNER_LOGIN, or log the node in as that user",
			"nodeOwner", nodeOwner.Login, "HUSSLA_OWNER_LOGIN", pinned)
	}
}

func buildServices(dataDir string, storage *sqlite.Store, logger *slog.Logger, ownerLogin string) (httpapi.Deps, error) {
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
			Store: storage, Ceremony: passkey.Ceremony{}, SignIn: signinfile.New(dataDir), OwnerLogin: ownerLogin,
			AnnounceSetupCode: func(code string) {
				logger.Warn("Setup code (valid until used): " + code + " (enter it on the setup screen to claim this install and add your passkey; it stays the same across restarts)")
			},
			RemindSetupCode: func(issuedAt time.Time) {
				logger.Warn("Setup code: unchanged; use the last \"Setup code (valid until used)\" line in this log, printed " + issuedAt.UTC().Format(time.RFC3339))
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
