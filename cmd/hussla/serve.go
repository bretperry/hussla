// The composition root: takes the data-directory lock, opens storage, builds the use-cases, and serves its listeners until a signal.
// In the app: everything `hussla serve` does between start and stop.
// Used by: main.go.
// Uses: every adapter (sqlite, tailnet, passkey, filestore, signinfile, datadir, secretfile, mailfactory) and every use-case; httpapi for the handlers.
//
// Start order is for speed and safety: lock first (a second process stops before touching
// anything), then storage, then the local and home-network listeners (serving in well under a
// second), then the tailnet in the background (joining can wait on a login, and retries until it
// works; once joined it is re-read every config.TailnetRefresh), and the outbox dispatcher. Stop
// order is the reverse: stop taking requests, let the ones in flight finish (config.ShutdownGrace),
// let the dispatcher and a backup finish, close the tailnet, close storage, release the lock.

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
	"github.com/bretperry/hussla/internal/adapters/mailfactory"
	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/adapters/secretfile"
	"github.com/bretperry/hussla/internal/adapters/signinfile"
	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/adapters/tailnet"
	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/outbox"
	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/httpapi"
	"github.com/bretperry/hussla/internal/mcpapi"
)

// localAddressFile records the local listener's address, so `hussla open` finds the port.
const localAddressFile = "local-address"

// settings is the environment, read once.
type settings struct {
	dataDir    string
	hostname   string
	authKey    string
	tailnet    bool
	localPort  string // "" for none
	homePort   string // the home-network page's port on every interface; "" for none
	ownerLogin string // pins the owner's tailnet login; "" for anyone eligible
}

func settingsFrom(getenv func(string) string) settings {
	result := settings{dataDir: getenv("DATA_DIR"), hostname: getenv("HUSSLA_HOSTNAME"), authKey: getenv("TS_AUTHKEY"), tailnet: getenv("HUSSLA_TAILNET") != "off", localPort: getenv("HUSSLA_LOCAL_PORT"), homePort: getenv("HUSSLA_HOME_PORT"), ownerLogin: getenv("HUSSLA_OWNER_LOGIN")}
	if result.homePort == "off" {
		result.homePort = ""
	}
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

	storage, err := sqlite.Open(ctx, sqlite.Options{Dir: dataDir, AppVersion: config.Version})
	if err != nil {
		return fmt.Errorf("open storage: %w", err)
	}
	defer func() { _ = storage.Close() }()

	var node tailnetNode
	if env.tailnet {
		node = newTailnetNode(tailnet.Options{DataDir: dataDir, Hostname: env.hostname, AuthKey: env.authKey, Logf: func(format string, args ...any) { logger.Info(fmt.Sprintf(format, args...)) }})
	}
	services, dispatcher, err := buildServices(dataDir, storage, logger, env.ownerLogin, node)
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

	if env.localPort != "" && env.localPort == env.homePort {
		return fmt.Errorf("HUSSLA_LOCAL_PORT and HUSSLA_HOME_PORT are both %s: give them different ports, or turn one off", env.localPort)
	}
	if env.localPort != "" {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", env.localPort))
		if err != nil {
			return fmt.Errorf("local listener: %w", err)
		}
		port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
		hosts := []string{"localhost:" + port, "127.0.0.1:" + port}
		handler := withMCP(httpapi.New(httpapi.Config{Listener: httpapi.ListenerLocal, Hosts: hosts}, services),
			mcpapi.New(mcpapi.Config{Hosts: hosts}, mcpDeps(services)))
		start("local", newServer(handler), listener)
		if err := os.WriteFile(filepath.Join(dataDir, localAddressFile), []byte("localhost:"+port), 0o600); err != nil {
			return fmt.Errorf("record local address: %w", err)
		}
		logger.Info("listening", "url", "http://localhost:"+port, "signin", "run `hussla open`")
	}
	if env.homePort != "" {
		listener, err := net.Listen("tcp", net.JoinHostPort("", env.homePort))
		if err != nil {
			return fmt.Errorf("home-network listener: %w", err)
		}
		start("home", newServer(httpapi.NewHome(services.Setup)), listener)
		port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
		logger.Info("home-network page: open http://<this machine's address>:" + port + " in a browser on the same network to finish setup")
	}

	var tailnetMutex sync.Mutex
	if node != nil {
		go func() {
			listener, err := joinTailnet(ctx, node, logger)
			if err != nil {
				return // stopping
			}
			adoptNodeOwner(ctx, services.Auth, node.NodeOwner(), logger)
			if err := services.Auth.IssueSetupCode(ctx); err != nil {
				logger.Error("setup code", "error", err)
			}
			handler := &renamingHandler{current: node.Domain, build: func(name string) http.Handler {
				hosts := []string{name}
				// Fails closed while the node is logged in as someone other than the owner (API and /mcp alike).
				return httpapi.GuardNodeOwner(services.Setup, withMCP(httpapi.New(httpapi.Config{Listener: httpapi.ListenerTailnet, Hosts: hosts, Peers: node, PlainHTTP: !tailnetHTTPS}, services),
					mcpapi.New(mcpapi.Config{Hosts: hosts, Secure: tailnetHTTPS}, mcpDeps(services))))
			}}
			tailnetMutex.Lock()
			if ctx.Err() != nil { // stopping already: don't start a server nobody will shut down
				tailnetMutex.Unlock()
				_ = listener.Close()
				return
			}
			start("tailnet", newServer(handler), listener)
			if redirect, err := node.RedirectListener(); err == nil {
				start("tailnet-redirect", newServer(httpapi.NewRedirect(node.Domain)), redirect)
			} else {
				logger.Warn("tailnet: no http:// redirect", "error", err)
			}
			tailnetMutex.Unlock()
			logger.Info("Hussla is running: open this address on a device with Tailscale turned on", "url", services.Setup.Address())
			superviseTailnet(ctx, node, services.Auth, logger)
		}()
	}

	var background sync.WaitGroup
	background.Add(1)
	go func() {
		defer background.Done()
		if err := dispatcher.Run(ctx); err != nil {
			logger.Error("outbox stopped", "error", err)
		}
	}()

	background.Add(1)
	go func() {
		defer background.Done()
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
	background.Wait() // a send or a backup in progress finishes before storage closes
	tailnetMutex.Lock()
	if node != nil {
		_ = node.Close()
	}
	tailnetMutex.Unlock()
	_ = os.Remove(filepath.Join(dataDir, localAddressFile))
	logger.Info("stopped")
	return nil
}

// mcpDeps are the use-cases the MCP tools call: the very instances the HTTP API calls.
func mcpDeps(services httpapi.Deps) mcpapi.Deps {
	return mcpapi.Deps{Auth: services.Auth, Tracker: services.Tracker, Mail: services.Mail}
}

// withMCP serves config.MCPPath from the MCP handler and everything else from the HTTP API. The
// MCP handler does its own Host, Origin and agent-key checks: it never sees the API's cookie or
// tailnet identity, and the API's identity step never runs for /mcp.
func withMCP(api, mcp http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle(config.MCPPath, mcp)
	mux.Handle("/", api)
	return mux
}

func newServer(handler http.Handler) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
}

// tailnetNode is the server's tailnet node: tailnet.Node, or the end-to-end build's fake (tailnet_fake.go).
type tailnetNode interface {
	tailnetJoiner
	auth.PeerIdentifier
	auth.TailnetStatus
	RedirectListener() (net.Listener, error)
	Refresh(ctx context.Context) error
	Logout(ctx context.Context) error
	Domain() string
	NodeOwner() auth.TailnetPeer
	Close() error
}

// renamingHandler is the tailnet door, rebuilt when the node's name changes (a rename in the
// admin console, or a login into another tailnet after "Start over"), so the Host and Origin checks
// follow the new name instead of refusing it.
type renamingHandler struct {
	current func() string
	build   func(name string) http.Handler

	mutex   sync.Mutex
	name    string
	handler http.Handler
}

func (door *renamingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := door.current()
	door.mutex.Lock()
	if door.handler == nil || name != door.name {
		door.name, door.handler = name, door.build(name)
	}
	handler := door.handler
	door.mutex.Unlock()
	handler.ServeHTTP(w, r)
}

// tailnetRefresher is what superviseTailnet needs from the node (a fake in tests).
type tailnetRefresher interface {
	Refresh(ctx context.Context) error
	NodeOwner() auth.TailnetPeer
}

// superviseTailnet re-reads the joined node every config.TailnetRefresh until ctx ends: it picks
// up a rename, a key expiry and a new login, and adopts the node's owner when the install has
// none (after "Start over"). Each new problem is logged once.
func superviseTailnet(ctx context.Context, node tailnetRefresher, authService *auth.Service, logger *slog.Logger) {
	ticker := time.NewTicker(config.TailnetRefresh)
	defer ticker.Stop()
	lastOwner := node.NodeOwner().UserID
	lastProblem := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := node.Refresh(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			if problem := err.Error(); problem != lastProblem {
				lastProblem = problem
				logger.Warn("tailnet", "error", err)
			}
			continue
		}
		lastProblem = ""
		owner := node.NodeOwner()
		changed := owner.UserID != lastOwner
		lastOwner = owner.UserID
		if owner.UserID == "" {
			continue
		}
		enrolled, err := authService.Enrolled(ctx)
		if err != nil || enrolled {
			continue
		}
		// A pin that refuses this login is said once per new owner, not every refresh.
		if _, refuses := authService.PinRefuses(owner); changed || !refuses {
			adoptNodeOwner(ctx, authService, owner, logger)
		}
	}
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

// authNode is the node as auth sees it: nil without Tailscale (never a typed nil inside the interface).
func authNode(node tailnetNode) auth.NodeIdentity {
	if node == nil {
		return nil
	}
	return node
}

func buildServices(dataDir string, storage *sqlite.Store, logger *slog.Logger, ownerLogin string, node tailnetNode) (httpapi.Deps, *outbox.Dispatcher, error) {
	blobs, err := filestore.NewBlobs(filepath.Join(dataDir, "files"))
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("files: %w", err)
	}
	resumes, err := filestore.NewResumes(filepath.Join(dataDir, "resumes"))
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("résumés: %w", err)
	}
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("mail time zone: %w", err)
	}
	ui, err := fs.Sub(webApp, "web")
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("web app: %w", err)
	}
	secrets, err := secretfile.Open(dataDir)
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("secret store: %w", err)
	}
	mailSetup := mailsetup.NewService(mailsetup.Dependencies{Store: storage, Secrets: secrets, Factory: mailfactory.New, Logger: logger})
	dispatcher := outbox.New(outbox.Dependencies{Store: storage, Senders: mailSetup, Rules: domain.DefaultPacingRules(location), Logger: logger})
	authService := auth.New(auth.Options{
		Store: storage, Ceremony: passkey.Ceremony{}, SignIn: signinfile.New(dataDir), OwnerLogin: ownerLogin, Node: authNode(node),
		AnnounceSetupCode: func(code string) {
			logger.Warn("Setup code (valid until used): " + code + " (enter it on the setup screen to claim this install and add your passkey; it stays the same across restarts)")
		},
		RemindSetupCode: func(issuedAt time.Time) {
			logger.Warn("Setup code: unchanged; use the last \"Setup code (valid until used)\" line in this log, printed " + issuedAt.UTC().Format(time.RFC3339) + " (lost it? the owner can print a new one from the setup screen)")
		},
	})
	setupOptions := setup.Options{Auth: authService, Store: storage}
	if node != nil {
		setupOptions.Tailnet = node
	}
	if !tailnetHTTPS {
		setupOptions.Scheme = "http"
	}
	return httpapi.Deps{
		Auth:        authService,
		Tracker:     tracker.New(storage, nil),
		Mail:        mailbox.New(mailbox.Options{Store: storage, Location: location, Mailer: mailbox.SetupMailer{Setup: mailSetup}, Waker: dispatcher}),
		Attachments: attachments.New(storage, blobs, resumes, config.UploadMaxBytes, nil),
		Setup:       setup.New(setupOptions),
		MailSetup:   mailSetup,
		AgentsGuide: hussla.AgentsGuide,
		UI:          ui,
	}, dispatcher, nil
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
