// The first run on a headless host: what the home-network page shows, "Start over", the key-expiry warning, and the wizard's progress.
// In the app: http://<NAS address>:8484 before and during setup; the wizard after the first passkey; the key-expiry banner.
// Used by: internal/httpapi (the home-network page and the setup routes), cmd/hussla (builds it).
// Uses: the Tailnet port below (the tailnet adapter), auth.Service (owner, first-run window), settings (wizard progress), domain.KeyExpiryAt.
//
// The home-network page never grants identity: it reports the tailnet's progress, the ts.net
// address once there is one, and (inside the first-run window) the link that lets the node's owner
// add the first passkey on the tailnet address. Everything it offers is safe for anyone on the home
// network to see; "Start over" works only before any passkey was ever stored, and is loud about
// who owns the install, so a neighbor can't take it silently.

package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// Tailnet is the server's own tailnet node, as the setup pages need it. The tailnet adapter
// implements it; nil when Hussla runs without Tailscale.
type Tailnet interface {
	// State is the node's progress right now.
	State() auth.TailnetState
	// Logout signs the node out and asks for a new login link.
	Logout(ctx context.Context) error
}

// Phase is how far the tailnet is, as the home-network page words it.
type Phase int

const (
	// PhaseOff: Hussla runs without Tailscale (HUSSLA_TAILNET=off).
	PhaseOff Phase = iota
	// PhaseStarting: joining, or retrying.
	PhaseStarting
	// PhaseNeedsLogin: waiting for someone to sign in with the login link.
	PhaseNeedsLogin
	// PhaseNeedsHTTPS: on the tailnet, but HTTPS certificates or MagicDNS are off.
	PhaseNeedsHTTPS
	// PhaseRunning: serving at Address.
	PhaseRunning
	// PhaseNeedsApproval: signed in, waiting for a tailnet admin to approve this machine.
	PhaseNeedsApproval
)

// ErrNoTailnet: Hussla runs without Tailscale, so there is nothing to start over (409).
var ErrNoTailnet = errors.New("this Hussla runs without Tailscale")

// settingWizard holds the wizard's progress: which steps are done or skipped.
const settingWizard = "setup.wizard"

// Step states the wizard records.
const (
	StepDone    = "done"
	StepSkipped = "skipped"
)

// Options build a Service.
type Options struct {
	Auth    *auth.Service
	Tailnet Tailnet // nil without Tailscale
	Store   store.Store
	Now     func() time.Time // time.Now when nil
	// Scheme is the tailnet address's scheme: "https" (the default); the end-to-end test build's
	// fake tailnet serves "http" on localhost.
	Scheme string
}

// Service runs the first-run use-cases.
type Service struct {
	auth    *auth.Service
	tailnet Tailnet
	store   store.Store
	now     func() time.Time
	scheme  string
}

// New builds the Service.
func New(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	scheme := options.Scheme
	if scheme == "" {
		scheme = "https"
	}
	return &Service{auth: options.Auth, tailnet: options.Tailnet, store: options.Store, now: now, scheme: scheme}
}

// Home is what the home-network page shows.
type Home struct {
	Phase    Phase
	LoginURL string // tsnet's login link, while PhaseNeedsLogin
	Address  string // https://<name>.ts.net once known
	// OwnerLogin is the tailnet login the install belongs to, while no passkey was ever stored.
	OwnerLogin   string
	CanStartOver bool
	// FirstRunLink is the secret for "Make it mine" (the first-run window is open and the node's owner is known).
	FirstRunLink    string
	FirstRunUntil   time.Time
	MinutesLeft     int  // whole minutes the link still works (at least 1 while it does)
	FirstRunExpired bool // the window has closed without a passkey: restart, or use the log's code
	SetupDone       bool // a passkey exists: the page only points at the address
	KeyExpiry       domain.KeyExpiry
}

// Home reads what the home-network page shows right now.
func (s *Service) Home(ctx context.Context) (Home, error) {
	state := s.TailnetState()
	home := Home{Phase: phaseOf(state, s.tailnet != nil), KeyExpiry: domain.KeyExpiryAt(s.now(), state.KeyExpiry)}
	home.Address = s.Address()
	if home.Phase == PhaseNeedsLogin {
		home.LoginURL = state.AuthURL
	}
	canStartOver, err := s.auth.CanStartOver(ctx)
	if err != nil {
		return Home{}, err //nolint:wrapcheck // auth wraps its own
	}
	home.SetupDone = !canStartOver
	if home.SetupDone {
		return home, nil
	}
	if home.OwnerLogin, err = s.auth.OwnerLogin(ctx); err != nil {
		return Home{}, err //nolint:wrapcheck // auth wraps its own
	}
	home.CanStartOver = s.tailnet != nil && home.OwnerLogin != ""
	firstRun, err := s.auth.FirstRunState(ctx)
	if err != nil {
		return Home{}, err //nolint:wrapcheck // auth wraps its own
	}
	home.FirstRunUntil = firstRun.ClosesAt
	home.FirstRunExpired = !firstRun.Open
	if firstRun.Open && home.Phase == PhaseRunning && home.OwnerLogin != "" {
		home.FirstRunLink = firstRun.Link
		home.MinutesLeft = max(1, int(firstRun.ClosesAt.Sub(s.now())/time.Minute))
	}
	return home, nil
}

func phaseOf(state auth.TailnetState, on bool) Phase {
	if !on {
		return PhaseOff
	}
	switch state.Phase {
	case auth.TailnetNeedsLogin:
		return PhaseNeedsLogin
	case auth.TailnetNeedsHTTPS:
		return PhaseNeedsHTTPS
	case auth.TailnetRunning:
		return PhaseRunning
	case auth.TailnetNeedsApproval:
		return PhaseNeedsApproval
	case auth.TailnetStarting:
		return PhaseStarting
	}
	return PhaseStarting
}

// TailnetState is the node's state (the zero state without Tailscale).
func (s *Service) TailnetState() auth.TailnetState {
	if s.tailnet == nil {
		return auth.TailnetState{}
	}
	return s.tailnet.State()
}

// Address is the tailnet address ("https://hussla.<tailnet>.ts.net"), or "" before there is one.
func (s *Service) Address() string {
	name := s.TailnetState().Domain
	if name == "" {
		return ""
	}
	return s.scheme + "://" + name
}

// KeyExpiry is the node key's warning state now.
func (s *Service) KeyExpiry() domain.KeyExpiry {
	return domain.KeyExpiryAt(s.now(), s.TailnetState().KeyExpiry)
}

// StartOver logs the node out of Tailscale and releases the recorded owner, so whoever signs in
// next with the new login link owns the install. Only before any passkey was ever stored.
func (s *Service) StartOver(ctx context.Context) error {
	if s.tailnet == nil {
		return ErrNoTailnet
	}
	allowed, err := s.auth.CanStartOver(ctx)
	if err != nil {
		return err //nolint:wrapcheck // auth wraps its own
	}
	if !allowed {
		return auth.ErrStartOverClosed
	}
	if err := s.tailnet.Logout(ctx); err != nil {
		return fmt.Errorf("start over: %w", err)
	}
	return s.auth.StartOver(ctx) //nolint:wrapcheck // auth wraps its own
}

// Wizard is the wizard's progress: each step's state ("done", "skipped", or absent).
type Wizard struct {
	Steps    map[string]string `json:"steps"`
	Finished bool              `json:"-"`
}

// Wizard reads the wizard's progress.
func (s *Service) Wizard(ctx context.Context) (Wizard, error) {
	var wizard Wizard
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		wizard, err = readWizard(ctx, tx)
		return err
	})
	if err != nil {
		return Wizard{}, fmt.Errorf("read setup progress: %w", err)
	}
	return wizard, nil
}

// MarkStep records one step as done or skipped (owner only); the other steps keep their state.
func (s *Service) MarkStep(ctx context.Context, owner auth.Principal, step, state string) (Wizard, error) {
	if !owner.IsOwner() {
		return Wizard{}, auth.ErrNotOwner
	}
	if !slices.Contains(config.WizardSteps, step) {
		return Wizard{}, &domain.ValidationError{Field: "step", Problem: "isn't a setup step"}
	}
	if state != StepDone && state != StepSkipped {
		return Wizard{}, &domain.ValidationError{Field: "state", Problem: `is "done" or "skipped"`}
	}
	var wizard Wizard
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		var err error
		wizard, err = readWizard(ctx, tx)
		if err != nil {
			return err
		}
		if wizard.Steps[step] == state {
			return nil // a retry is a no-op
		}
		wizard.Steps[step] = state
		encoded, err := json.Marshal(wizard)
		if err != nil {
			return fmt.Errorf("encode setup progress: %w", err)
		}
		return tx.Settings().Set(ctx, settingWizard, string(encoded))
	})
	if err != nil {
		return Wizard{}, fmt.Errorf("save setup progress: %w", err)
	}
	wizard.Finished = finished(wizard)
	return wizard, nil
}

func readWizard(ctx context.Context, tx store.Tx) (Wizard, error) {
	wizard := Wizard{Steps: map[string]string{}}
	text, err := tx.Settings().Get(ctx, settingWizard)
	if errors.Is(err, storeerr.ErrNotFound) {
		return wizard, nil
	}
	if err != nil {
		return Wizard{}, err
	}
	if err := json.Unmarshal([]byte(text), &wizard); err != nil {
		return Wizard{}, fmt.Errorf("setup progress is damaged: %w", err)
	}
	if wizard.Steps == nil {
		wizard.Steps = map[string]string{}
	}
	wizard.Finished = finished(wizard)
	return wizard, nil
}

func finished(wizard Wizard) bool {
	for _, step := range config.WizardSteps {
		if wizard.Steps[step] == "" {
			return false
		}
	}
	return true
}
