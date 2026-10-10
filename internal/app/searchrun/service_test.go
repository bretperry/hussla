// Tests for the Search now use-cases: reading the routine id, keeping the token, the cooldown, and what a run records.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package searchrun_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

const routineURL = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef234/fire"

// fakeFirer records each fire and answers with its scripted error, or a session link.
type fakeFirer struct {
	fires []fire
	err   error
}

type fire struct {
	routineID, token, text string
	cancelled              bool // the fire's context was already done
}

func (firer *fakeFirer) Fire(ctx context.Context, routineID string, token mailsetup.Secret, text string) (searchrun.Fired, error) {
	firer.fires = append(firer.fires, fire{routineID: routineID, token: token.Reveal(), text: text, cancelled: ctx.Err() != nil})
	if firer.err != nil {
		return searchrun.Fired{}, firer.err
	}
	return searchrun.Fired{SessionURL: "https://claude.ai/code/session_01XYZ"}, nil
}

type rig struct {
	service *searchrun.Service
	store   store.Store
	secrets *fakes.SecretStore
	firer   *fakeFirer
	now     time.Time
}

func newRig() *rig {
	r := &rig{store: fakes.New(), secrets: &fakes.SecretStore{}, firer: &fakeFirer{}, now: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)}
	r.service = searchrun.New(searchrun.Dependencies{Store: r.store, Secrets: r.secrets, Firer: r.firer, Now: func() time.Time { return r.now }})
	return r
}

func token(value string) *mailsetup.Secret {
	wrapped := mailsetup.NewSecret(value)
	return &wrapped
}

func (r *rig) events(t *testing.T) []domain.Event {
	t.Helper()
	var list []domain.Event
	err := r.store.View(context.Background(), func(tx store.Tx) error {
		found, err := tx.Events().List(context.Background(), events.Filter{})
		list = found
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func TestParseRoutineID(t *testing.T) {
	good := map[string]string{
		"the API URL":       routineURL,
		"the bare id":       "trig_01ABCdef234",
		"with spaces":       "  trig_01ABCdef234\n",
		"the routines page": "https://claude.ai/code/routines/trig_01ABCdef234",
	}
	if got, err := searchrun.ParseRoutineID("https://api.anthropic.com/v1/claude_code/routines/trig_01a_b-C/fire"); err != nil || got != "trig_01a_b-C" {
		t.Errorf("an id with _ and -: got %q, %v", got, err)
	}
	for name, input := range good {
		got, err := searchrun.ParseRoutineID(input)
		if err != nil || got != "trig_01ABCdef234" {
			t.Errorf("%s: got %q, %v", name, got, err)
		}
	}
	for _, input := range []string{"", "trig_", "https://example.com/fire", "session_01ABC"} {
		var validation *domain.ValidationError
		if _, err := searchrun.ParseRoutineID(input); !errors.As(err, &validation) {
			t.Errorf("%q: want a ValidationError, got %v", input, err)
		}
	}
}

func TestSaveNeedsATokenForANewRoutine(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	var validation *domain.ValidationError
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL}, "Owner"); !errors.As(err, &validation) {
		t.Fatalf("no token yet: want a ValidationError, got %v", err)
	}
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("  ")}, "Owner"); !errors.As(err, &validation) {
		t.Fatalf("blank token: want a ValidationError, got %v", err)
	}
	view, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("sk-ant-oat01-secret")}, "Owner")
	if err != nil || !view.Configured() || view.RoutineID != "trig_01ABCdef234" {
		t.Fatalf("save: %+v, %v", view, err)
	}
	// Same routine, no token: the stored one stays.
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: "trig_01ABCdef234"}, "Owner"); err != nil {
		t.Fatalf("same routine without a token: %v", err)
	}
	// A different routine needs its own token.
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: "trig_02Other"}, "Owner"); !errors.As(err, &validation) {
		t.Fatalf("new routine without a token: want a ValidationError, got %v", err)
	}
	stored, err := r.secrets.Get(ctx, searchrun.SecretName)
	if err != nil || stored.Reveal() != "trig_01ABCdef234\nsk-ant-oat01-secret" {
		t.Fatalf("stored token: %v", err)
	}
	for _, event := range r.events(t) {
		if strings.Contains(event.Action+event.Detail, "secret") {
			t.Errorf("the activity log holds the token: %+v", event)
		}
	}
}

func TestRunNeedsASetup(t *testing.T) {
	r := newRig()
	if _, err := r.service.Run(context.Background(), "Owner"); !errors.Is(err, searchrun.ErrNotConfigured) {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
	if len(r.firer.fires) != 0 {
		t.Fatal("fired with no setup")
	}
}

func TestRunFiresTheRoutineAndRecordsIt(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	run, err := r.service.Run(ctx, "Owner")
	if err != nil {
		t.Fatal(err)
	}
	if run.SessionURL != "https://claude.ai/code/session_01XYZ" || !run.StartedAt.Equal(r.now) {
		t.Fatalf("run: %+v", run)
	}
	if len(r.firer.fires) != 1 || r.firer.fires[0].routineID != "trig_01ABCdef234" || r.firer.fires[0].token != "tok" {
		t.Fatalf("fires: %+v", r.firer.fires)
	}
	view, err := r.service.View(ctx)
	if err != nil || !view.LastRunAt.Equal(r.now) || view.LastSessionURL != run.SessionURL {
		t.Fatalf("view after run: %+v, %v", view, err)
	}
	if latest := r.events(t)[0]; latest.Action != "Started a job search" || latest.Detail != run.SessionURL {
		t.Fatalf("activity: %+v", latest)
	}
}

func TestRunCooldown(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.service.Run(ctx, "Owner"); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(config.SearchRunCooldown - time.Second)
	if _, err := r.service.Run(ctx, "Owner"); !errors.Is(err, searchrun.ErrTooSoon) {
		t.Fatalf("inside the cooldown: want ErrTooSoon, got %v", err)
	}
	r.now = r.now.Add(time.Second)
	if _, err := r.service.Run(ctx, "Owner"); err != nil {
		t.Fatalf("after the cooldown: %v", err)
	}
	if len(r.firer.fires) != 2 {
		t.Fatalf("want 2 fires, got %d", len(r.firer.fires))
	}
}

func TestAFailedFireStartsNoCooldown(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	r.firer.err = searchrun.ErrTokenRejected
	if _, err := r.service.Run(ctx, "Owner"); !errors.Is(err, searchrun.ErrTokenRejected) {
		t.Fatalf("want ErrTokenRejected through, got %v", err)
	}
	r.firer.err = nil
	if _, err := r.service.Run(ctx, "Owner"); err != nil {
		t.Fatalf("retry after a failed fire: %v", err)
	}
}

func TestAMaybeStartedFireStartsTheCooldown(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	r.firer.err = &searchrun.FireError{Reason: "no answer from Claude: timeout", MaybeStarted: true}
	if _, err := r.service.Run(ctx, "Owner"); err == nil {
		t.Fatal("want the fire's error")
	}
	r.firer.err = nil
	if _, err := r.service.Run(ctx, "Owner"); !errors.Is(err, searchrun.ErrTooSoon) {
		t.Fatalf("after a fire that may have started: want ErrTooSoon, got %v", err)
	}
	if latest := r.events(t)[0]; latest.Action != "Search may have started" {
		t.Fatalf("activity: %+v", latest)
	}
}

func TestRunOutlivesTheRequest(t *testing.T) {
	r := newRig()
	if _, err := r.service.Save(context.Background(), searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	closedTab, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.service.Run(closedTab, "Owner"); err != nil {
		t.Fatal(err)
	}
	if r.firer.fires[0].cancelled {
		t.Fatal("the fire ran on the cancelled request context")
	}
}

func TestAClockThatWentBackDoesNotBlockTheButton(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.service.Save(ctx, searchrun.SaveInput{Routine: routineURL, Token: token("tok")}, "Owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.service.Run(ctx, "Owner"); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(-time.Hour)
	if _, err := r.service.Run(ctx, "Owner"); err != nil {
		t.Fatalf("with the last run in the future: %v", err)
	}
}

func TestSaveRefusesATokenWithSpaces(t *testing.T) {
	r := newRig()
	var validation *domain.ValidationError
	if _, err := r.service.Save(context.Background(), searchrun.SaveInput{Routine: routineURL, Token: token("sk-ant\nmore")}, "Owner"); !errors.As(err, &validation) {
		t.Fatalf("want a ValidationError, got %v", err)
	}
}
