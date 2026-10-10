// The Search now use-cases: save which Claude routine runs the job search, and start it on the owner's click.
// In the app: Settings → Job search (View, Save) and the Search now button on the Jobs page (Run).
// Used by: internal/httpapi (owner-only routes), cmd/hussla (wires the routinefire adapter).
// Uses: store.Store (settings, events), mailsetup.SecretStore for the token, Firer, config.SearchRunCooldown.
//
// The token goes only into the SecretStore and comes back out only to the Firer; View says whether
// one is stored, never what it is. The routine does the searching and writes back over the agent
// API like any agent; Hussla only starts it and records where the run can be watched.

package searchrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// SettingsKey is where the routine id and the last run are stored, as JSON.
const SettingsKey = "search-routine"

// SecretName is the SecretStore name of the routine's API trigger token.
const SecretName = "search.routine-token"

// routinePrefix starts every routine id ("trig_01…").
const routinePrefix = "trig_"

// stored is the settings row.
type stored struct {
	RoutineID      string `json:"routineId"`
	LastRunAt      string `json:"lastRunAt,omitempty"`
	LastSessionURL string `json:"lastSessionUrl,omitempty"`
}

// View is the setup and the last run, without the token.
type View struct {
	RoutineID      string
	HasToken       bool
	LastRunAt      time.Time
	LastSessionURL string
}

// Configured is true when the button can fire.
func (view View) Configured() bool { return view.RoutineID != "" && view.HasToken }

// SaveInput is a new setup. Routine is the routine's id or any URL that holds it; a nil Token keeps
// the stored one (allowed only for the same routine, since a token fires only its own routine).
type SaveInput struct {
	Routine string
	Token   *mailsetup.Secret
}

// Run is one started search.
type Run struct {
	StartedAt  time.Time
	SessionURL string
}

// Service is the Search now use-cases.
type Service struct {
	store   store.Store
	secrets mailsetup.SecretStore
	firer   Firer
	logger  *slog.Logger
	now     func() time.Time
	// running makes Run one at a time, so two clicks can't both pass the cooldown check before either records its run.
	running sync.Mutex
}

// Dependencies are what Service needs; Logger and Now default to slog.Default and time.Now.
type Dependencies struct {
	Store   store.Store
	Secrets mailsetup.SecretStore
	Firer   Firer
	Logger  *slog.Logger
	Now     func() time.Time
}

// New builds the Search now use-cases.
func New(dependencies Dependencies) *Service {
	service := &Service{
		store: dependencies.Store, secrets: dependencies.Secrets, firer: dependencies.Firer,
		logger: dependencies.Logger, now: dependencies.Now,
	}
	if service.logger == nil {
		service.logger = slog.Default()
	}
	if service.now == nil {
		service.now = time.Now
	}
	return service
}

// View returns the setup and the last run.
func (service *Service) View(ctx context.Context) (View, error) {
	current, err := service.load(ctx)
	if err != nil {
		return View{}, err
	}
	hasToken, err := service.hasToken(ctx)
	if err != nil {
		return View{}, err
	}
	return viewOf(current, hasToken)
}

// Save stores the routine (and a new token when given) and logs the change, without the token.
// Owner only; the HTTP layer checks the passkey tap.
func (service *Service) Save(ctx context.Context, input SaveInput, actor string) (View, error) {
	routineID, err := ParseRoutineID(input.Routine)
	if err != nil {
		return View{}, err
	}
	previous, err := service.load(ctx)
	if err != nil {
		return View{}, err
	}
	if input.Token != nil {
		if strings.TrimSpace(input.Token.Reveal()) == "" {
			return View{}, &domain.ValidationError{Field: "token", Problem: "is empty"}
		}
	} else {
		hasToken, err := service.hasToken(ctx)
		if err != nil {
			return View{}, err
		}
		if !hasToken || previous.RoutineID != routineID {
			return View{}, &domain.ValidationError{Field: "token", Problem: "is required for a new routine (each routine has its own token)"}
		}
	}
	// The token first: if the settings write then fails, the next save sends both again.
	if input.Token != nil {
		token := mailsetup.NewSecret(strings.TrimSpace(input.Token.Reveal()))
		if err := service.secrets.Put(ctx, SecretName, token); err != nil {
			return View{}, fmt.Errorf("store the routine token: %w", err)
		}
	}
	next := previous
	next.RoutineID = routineID
	detail := "Routine " + routineID
	if input.Token != nil {
		detail += " (new token)"
	}
	if err := service.write(ctx, next, actor, "Set up the search button", detail); err != nil {
		return View{}, err
	}
	return viewOf(next, true)
}

// Run starts the routine now, unless a search started within config.SearchRunCooldown.
// Errors: ErrNotConfigured, ErrTooSoon, and the Firer's.
func (service *Service) Run(ctx context.Context, actor string) (Run, error) {
	service.running.Lock()
	defer service.running.Unlock()
	current, err := service.load(ctx)
	if err != nil {
		return Run{}, err
	}
	if current.RoutineID == "" {
		return Run{}, ErrNotConfigured
	}
	token, err := service.secrets.Get(ctx, SecretName)
	if errors.Is(err, mailsetup.ErrSecretNotFound) {
		return Run{}, ErrNotConfigured
	}
	if err != nil {
		return Run{}, fmt.Errorf("read the routine token: %w", err)
	}
	now := domain.NormalizeTime(service.now())
	lastRunAt, err := domain.ParseTimestamp(current.LastRunAt)
	if err != nil {
		return Run{}, fmt.Errorf("stored search run: %w", err)
	}
	if !lastRunAt.IsZero() && now.Sub(lastRunAt) < config.SearchRunCooldown {
		return Run{}, ErrTooSoon
	}
	text := "Started from " + config.ProductName + "'s Search now button by " + actor + " at " + domain.FormatTimestamp(now) + "."
	fired, err := service.firer.Fire(ctx, current.RoutineID, token, text)
	if err != nil {
		service.logger.Warn("search routine didn't start", "routine", current.RoutineID, "error", err)
		return Run{}, fmt.Errorf("start the search routine: %w", err)
	}
	service.logger.Info("search routine started", "routine", current.RoutineID, "session", fired.SessionURL)
	run := Run{StartedAt: now, SessionURL: fired.SessionURL}
	current.LastRunAt = domain.FormatTimestamp(now)
	current.LastSessionURL = fired.SessionURL
	// The run has started whatever happens next, so a failed record is logged, not returned: the
	// owner still gets the link, and only the cooldown and the activity line miss it.
	if err := service.write(ctx, current, actor, "Started a job search", fired.SessionURL); err != nil {
		service.logger.Error("record the search run", "error", err)
	}
	return run, nil
}

// ParseRoutineID finds the routine id ("trig_" and letters and digits) in an id or a URL that holds one.
func ParseRoutineID(text string) (string, error) {
	invalid := &domain.ValidationError{Field: "routine", Problem: "must be the routine's API URL or its id (it starts with " + routinePrefix + ")"}
	start := strings.Index(text, routinePrefix)
	if start < 0 {
		return "", invalid
	}
	end := start + len(routinePrefix)
	for end < len(text) && isIDCharacter(text[end]) {
		end++
	}
	if end == start+len(routinePrefix) {
		return "", invalid
	}
	return text[start:end], nil
}

func isIDCharacter(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9'
}

func viewOf(current stored, hasToken bool) (View, error) {
	lastRunAt, err := domain.ParseTimestamp(current.LastRunAt)
	if err != nil {
		return View{}, fmt.Errorf("stored search run: %w", err)
	}
	return View{RoutineID: current.RoutineID, HasToken: hasToken, LastRunAt: lastRunAt, LastSessionURL: current.LastSessionURL}, nil
}

// load reads the settings row; a missing row is the zero setup.
func (service *Service) load(ctx context.Context) (stored, error) {
	var raw string
	err := service.store.View(ctx, func(tx store.Tx) error {
		value, err := tx.Settings().Get(ctx, SettingsKey)
		raw = value
		return err // the caller tells storeerr.ErrNotFound apart and wraps the rest
	})
	if errors.Is(err, storeerr.ErrNotFound) {
		return stored{}, nil
	}
	if err != nil {
		return stored{}, fmt.Errorf("read the search routine: %w", err)
	}
	var current stored
	if err := json.Unmarshal([]byte(raw), &current); err != nil {
		return stored{}, fmt.Errorf("read the search routine: %w", err)
	}
	return current, nil
}

// write stores the settings row and its activity line in one unit of work.
func (service *Service) write(ctx context.Context, next stored, actor, action, detail string) error {
	encoded, err := json.Marshal(next)
	if err != nil {
		return fmt.Errorf("encode the search routine: %w", err)
	}
	err = service.store.Atomically(ctx, func(tx store.Tx) error {
		if err := tx.Settings().Set(ctx, SettingsKey, string(encoded)); err != nil {
			return fmt.Errorf("save the search routine: %w", err)
		}
		event, err := domain.NewEvent("", actor, action, detail, service.now())
		if err != nil {
			return fmt.Errorf("log %q: %w", action, err)
		}
		if _, err := tx.Events().Append(ctx, event); err != nil {
			return fmt.Errorf("log %q: %w", action, err)
		}
		return nil
	})
	return err //nolint:wrapcheck // the work's errors are wrapped where they arise; the store's own failure passes through
}

func (service *Service) hasToken(ctx context.Context) (bool, error) {
	_, err := service.secrets.Get(ctx, SecretName)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, mailsetup.ErrSecretNotFound):
		return false, nil
	default:
		return false, fmt.Errorf("read the routine token: %w", err)
	}
}
