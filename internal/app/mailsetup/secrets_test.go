// TestSecretsNeverLeave at the use-case and adapter level: the mail credential appears in no returned value, error, stored row or log line.
// In the app: nothing (tests only).
// Used by: pnpm go:test.
//
// The plan's version runs through the Phase 3 router (every API response); that lands when
// Phases 3 and 4 meet. This one covers what the router will return and log: the use-case results,
// their errors, what the outbox stores and logs, with a provider that echoes the password back.

package mailsetup_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/bretperry/hussla/internal/adapters/mailfactory"
	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/outbox"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

var emailsFilterAll = emailsFilter()

const leakySecret = "hunter2-synthetic-Pa55" // synthetic

// leaks lists every form the secret could show up in.
func leaks(text string) []string {
	var found []string
	for _, form := range []string{leakySecret, base64.StdEncoding.EncodeToString([]byte(leakySecret)), fmt.Sprintf("%x", leakySecret)} {
		if strings.Contains(text, form) {
			found = append(found, form)
		}
	}
	return found
}

// render is everything a value could print as: fmt verbs, JSON, and both slog handlers.
func render(value any) string {
	var buffer bytes.Buffer
	fmt.Fprintf(&buffer, "%v|%+v|%#v|%s|%q|%x\n", value, value, value, value, value, value)
	encoded, _ := json.Marshal(value)
	buffer.Write(encoded)
	slog.New(slog.NewJSONHandler(&buffer, nil)).Info("value", "v", value)
	slog.New(slog.NewTextHandler(&buffer, nil)).Info("value", "v", value)
	return buffer.String()
}

type syncBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(p)
}

func (b *syncBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

func TestSecretPrintsRedactedEveryWay(t *testing.T) {
	secret := mailsetup.NewSecret(leakySecret)
	holders := []any{
		secret,
		&secret,
		mailsetup.Connection{Host: "smtp.example.com", Secret: secret},
		struct{ hidden mailsetup.Secret }{secret}, // an unexported field: fmt can't call its methods
		mailsetup.SaveInput{Secret: &secret},
	}
	for i, holder := range holders {
		if found := leaks(render(holder)); len(found) > 0 {
			t.Errorf("holder %d printed the secret as %v", i, found)
		}
	}
}

func TestSecretsNeverLeave(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx := context.Background()
		logs := &syncBuffer{}
		logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		textLogger := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		state := fakes.New()
		secrets := &fakes.SecretStore{}
		// A careless provider: every failure echoes the password, raw and base64.
		echo := mailsetup.NotSentRefused("535 auth failed for " + leakySecret + " / " + base64.StdEncoding.EncodeToString([]byte(leakySecret)))
		sender := &fakes.MailSender{}
		sender.Script(fakes.SendOutcome{Err: echo}, fakes.SendOutcome{Err: echo}, fakes.SendOutcome{Err: mailsetup.MaybeSent("dropped after DATA; " + leakySecret)})
		var built []mailsetup.MailSender
		service := mailsetup.NewService(mailsetup.Dependencies{
			Store: state, Secrets: secrets, Logger: logger,
			Factory: func(connection mailsetup.Connection) (mailsetup.MailSender, error) {
				real, err := mailfactory.New(connection) // the real adapter holds the secret; it must not print it
				built = append(built, real)
				return sender, err
			},
		})
		var returned []any
		save := func(input mailsetup.SaveInput) {
			view, err := service.Save(ctx, input, "Jane")
			returned = append(returned, view, err)
		}
		pw := mailsetup.NewSecret(leakySecret)
		save(mailsetup.SaveInput{Settings: mailsetup.Settings{ProviderID: "icloud", Username: "jane@icloud.com", FromAddress: "jane@icloud.com"}, Secret: &pw})
		save(mailsetup.SaveInput{Settings: mailsetup.Settings{ProviderID: "icloud", Username: "jane@icloud.com", FromAddress: "not an address"}, Secret: &pw})
		view, err := service.View(ctx)
		returned = append(returned, view, err)
		receipt, err := service.SendTest(ctx, "jane@icloud.com")
		returned = append(returned, receipt, err)
		ready, err := service.Sender(ctx)
		returned = append(returned, ready, err)
		for _, adapter := range built {
			returned = append(returned, adapter)
		}

		location, _ := time.LoadLocation(config.MailTimeZone)
		start := time.Date(2026, 10, 8, 9, 0, 0, 0, location)
		offset := time.Until(start)
		now := func() time.Time { return time.Now().Add(offset) }
		for _, id := range []string{"e1", "e2"} {
			draft, _ := domain.NewEmail(id, domain.EmailDraft{To: []string{"r@example.org"}, Subject: "Hi", Body: "Hi.\n", Kind: domain.EmailKindNote}, now())
			approved, _ := draft.Approve("Jane", 1, now())
			_ = state.Atomically(ctx, func(tx store.Tx) error { return tx.Emails().Create(ctx, approved) })
		}
		dispatcher := outbox.New(outbox.Dependencies{Store: state, Senders: service, Rules: domain.DefaultPacingRules(location), Now: now, Logger: textLogger})
		runContext, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- dispatcher.Run(runContext) }()
		time.Sleep(time.Hour)
		cancel()
		returned = append(returned, <-done)

		var stored []any
		_ = state.View(ctx, func(tx store.Tx) error {
			list, _ := tx.Emails().List(ctx, emailsFilterAll)
			eventList, _ := tx.Events().List(ctx, events.Filter{Limit: 1000})
			settingsList, _ := tx.Settings().All(ctx)
			stored = append(stored, list, eventList, settingsList)
			return nil
		})

		for i, value := range returned {
			if found := leaks(render(value)); len(found) > 0 {
				t.Errorf("returned value %d (%T) leaks the secret as %v", i, value, found)
			}
		}
		for i, value := range stored {
			if found := leaks(render(value)); len(found) > 0 {
				t.Errorf("stored rows %d leak the secret as %v", i, found)
			}
		}
		if found := leaks(logs.String()); len(found) > 0 {
			t.Errorf("logs leak the secret as %v:\n%s", found, logs.String())
		}
		if !strings.Contains(logs.String(), "[redacted]") {
			t.Error("the echoed password never reached the logs redacted: the test didn't exercise redaction")
		}
		if sender.Attempts() < 3 {
			t.Errorf("only %d sends were attempted: the failure paths weren't exercised", sender.Attempts())
		}
	})
}

func emailsFilter() emails.Filter { return emails.Filter{} }
