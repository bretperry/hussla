// Test harness for the dispatcher: the real mailsetup service and domain over the in-memory store, a scripted provider, and a movable wall clock.
// In the app: nothing (tests only).
// Used by: dispatcher_test.go, secrets_test.go.
//
// Every test runs inside testing/synctest, so hours of pacing cost nothing. The wall clock the
// dispatcher sees is the bubble's clock plus an offset the test can jump, which is how a laptop
// waking from sleep (or a clock set backwards) looks to the process.

package outbox_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/outbox"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

const testSecret = "synthetic-app-password-7f3a" // synthetic

type harness struct {
	t          *testing.T
	ctx        context.Context
	store      *fakes.Store
	sender     *fakes.MailSender
	secrets    *fakes.SecretStore
	service    *mailsetup.Service
	location   *time.Location
	offset     atomic.Int64
	logs       *lockedBuffer
	logger     *slog.Logger
	jitter     time.Duration
	nextNumber int
}

// newHarness starts the wall clock at `start` (a time in America/New_York) with mail set up for iCloud.
func newHarness(t *testing.T, start time.Time) *harness {
	t.Helper()
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t: t, ctx: context.Background(), store: fakes.New(), sender: &fakes.MailSender{},
		secrets: &fakes.SecretStore{}, location: location, logs: &lockedBuffer{},
	}
	h.offset.Store(int64(time.Until(start)))
	h.logger = slog.New(teeHandler{slog.NewJSONHandler(h.logs, nil), slog.NewTextHandler(h.logs, nil)})
	h.service = mailsetup.NewService(mailsetup.Dependencies{
		Store: h.store, Secrets: h.secrets, Logger: h.logger, Now: h.now,
		Factory: func(mailsetup.Connection) (mailsetup.MailSender, error) { return h.sender, nil },
	})
	secret := mailsetup.NewSecret(testSecret)
	_, err = h.service.Save(h.ctx, mailsetup.SaveInput{
		Settings: mailsetup.Settings{ProviderID: "icloud", Username: "jane@icloud.com", FromAddress: "jane@icloud.com", FromName: "Jane Doe"},
		Secret:   &secret,
	}, "Jane")
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *harness) now() time.Time { return time.Now().Add(time.Duration(h.offset.Load())) }

// jump moves the wall clock without the process noticing (a sleep, or the clock being set).
func (h *harness) jump(by time.Duration) { h.offset.Add(int64(by)) }

func (h *harness) dispatcher() *outbox.Dispatcher {
	return outbox.New(outbox.Dependencies{
		Store: h.store, Senders: h.service, Rules: domain.DefaultPacingRules(h.location),
		Now: h.now, Logger: h.logger, DrawJitter: func(time.Duration) time.Duration { return h.jitter },
	})
}

// run starts a dispatcher and returns a stop function that waits for it to return.
func (h *harness) run() (stop func()) {
	ctx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.dispatcher().Run(ctx) }()
	return func() {
		cancel()
		if err := <-done; err != nil {
			h.t.Errorf("Run: %v", err)
		}
	}
}

// approve creates an email approved by the owner now, and returns its id.
func (h *harness) approve(jobID string) string {
	h.t.Helper()
	h.nextNumber++
	id := fmt.Sprintf("e%d", h.nextNumber)
	draft, err := domain.NewEmail(id, domain.EmailDraft{
		JobID: jobID, To: []string{"recruiter@example.org"}, Subject: "Following up " + id, Body: "Hi.\n",
		Kind: domain.EmailKindFollowUp, CreatedBy: "agent:laptop",
	}, h.now())
	if err != nil {
		h.t.Fatal(err)
	}
	approved, err := draft.Approve("Jane", draft.Version, h.now())
	if err != nil {
		h.t.Fatal(err)
	}
	h.write(func(tx store.Tx) error { return tx.Emails().Create(h.ctx, approved) })
	return id
}

// reapprove is the owner approving a failed email again, at the version they see.
func (h *harness) reapprove(id string) {
	h.t.Helper()
	h.write(func(tx store.Tx) error {
		email, err := tx.Emails().Get(h.ctx, id)
		if err != nil {
			return err
		}
		next, err := email.Approve("Jane", email.Version, h.now())
		if err != nil {
			return err
		}
		return tx.Emails().Replace(h.ctx, email, next)
	})
}

func (h *harness) write(work func(store.Tx) error) {
	h.t.Helper()
	if err := h.store.Atomically(h.ctx, work); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) email(id string) domain.Email {
	h.t.Helper()
	var email domain.Email
	err := h.store.View(h.ctx, func(tx store.Tx) error {
		var err error
		email, err = tx.Emails().Get(h.ctx, id)
		return err
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return email
}

func (h *harness) events() []domain.Event {
	var list []domain.Event
	_ = h.store.View(h.ctx, func(tx store.Tx) error {
		var err error
		list, err = tx.Events().List(h.ctx, eventsFilterAll)
		return err
	})
	return list
}

// lockedBuffer collects log output from several goroutines.
type lockedBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return buffer.buffer.Write(data)
}

func (buffer *lockedBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return buffer.buffer.String()
}

// teeHandler writes every record to each handler (JSON and text), so a test sees both renderings.
type teeHandler []slog.Handler

func (handlers teeHandler) Enabled(context.Context, slog.Level) bool { return true }

func (handlers teeHandler) Handle(ctx context.Context, record slog.Record) error {
	for _, handler := range handlers {
		if err := handler.Handle(ctx, record.Clone()); err != nil {
			return err
		}
	}
	return nil
}

func (handlers teeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make(teeHandler, len(handlers))
	for i, handler := range handlers {
		next[i] = handler.WithAttrs(attrs)
	}
	return next
}

func (handlers teeHandler) WithGroup(name string) slog.Handler {
	next := make(teeHandler, len(handlers))
	for i, handler := range handlers {
		next[i] = handler.WithGroup(name)
	}
	return next
}
