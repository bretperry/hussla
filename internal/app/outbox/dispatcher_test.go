// Fault-injection tests for the outbox dispatcher on virtual time: pacing, the daily cap, the window, retries, crashes, sleep and clock jumps.
// In the app: nothing (tests only).
// Used by: pnpm go:test.
//
// Each test asserts what the fake provider holds and what the outbox rows say, never call counts:
// the guarantee is "at most once without a new approval, at a human pace".

package outbox_test

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/outbox"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

var eventsFilterAll = events.Filter{Limit: 10000}

// assertPaced fails when two deliveries are closer than the minimum gap (in process time).
func assertPaced(t *testing.T, delivered []fakes.Delivery, gap time.Duration) {
	t.Helper()
	for i := 1; i < len(delivered); i++ {
		if between := delivered[i].At.Sub(delivered[i-1].At); between < gap {
			t.Errorf("deliveries %d and %d are %v apart, want at least %v (a burst)", i-1, i, between, gap)
		}
	}
}

func TestSendsTheQueueAtAHumanPace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		h.jitter = 90 * time.Second
		ids := []string{h.approve(""), h.approve(""), h.approve(""), h.approve("")}
		stop := h.run()
		time.Sleep(2 * time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != len(ids) {
			t.Fatalf("delivered %d of %d", len(delivered), len(ids))
		}
		assertPaced(t, delivered, config.MailMinGap+h.jitter)
		for i, id := range ids {
			email := h.email(id)
			if email.Status != domain.EmailStatusSent || email.Attempts != 1 {
				t.Errorf("%s: %v after %d attempts", id, email.Status, email.Attempts)
			}
			want := mailsetup.MessageIDFor(id, email.Version, "jane@icloud.com")
			if delivered[i].Message.MessageID != want || delivered[i].Message.From.Email != "jane@icloud.com" {
				t.Errorf("%s went out as %+v", id, delivered[i].Message)
			}
		}
	})
}

func TestDailyCapCarriesTheRestToTomorrow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 8, 0, 0, 0, mustZone(t)))
		for range config.MailDailyLimit + 5 {
			h.approve("")
		}
		stop := h.run()
		time.Sleep(12 * time.Hour) // to 20:00: past the window
		if got := len(h.sender.Delivered()); got != config.MailDailyLimit {
			t.Errorf("day one delivered %d, want the cap %d", got, config.MailDailyLimit)
		}
		time.Sleep(12 * time.Hour) // to 08:00 the next day, and on through the morning
		time.Sleep(time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != config.MailDailyLimit+5 {
			t.Fatalf("delivered %d in total", len(delivered))
		}
		if dayTwo := delivered[config.MailDailyLimit].At.Sub(delivered[0].At); dayTwo < 23*time.Hour {
			t.Errorf("day two's first send came %v after day one's first", dayTwo)
		}
		assertPaced(t, delivered, config.MailMinGap)
	})
}

func TestAnApprovalOutsideTheWindowWaitsForIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 19, 30, 0, 0, mustZone(t)))
		id := h.approve("")
		stop := h.run()
		time.Sleep(12*time.Hour + 29*time.Minute) // 07:59 the next morning
		if got := len(h.sender.Delivered()); got != 0 {
			t.Errorf("sent %d outside the window", got)
		}
		time.Sleep(10 * time.Minute)
		stop()
		email := h.email(id)
		if email.Status != domain.EmailStatusSent {
			t.Fatalf("status %v", email.Status)
		}
		if local := email.SentAt.In(h.location); local.Hour() != 8 || local.Day() != 9 {
			t.Errorf("sent at %v, want shortly after 08:00 on the 9th", local)
		}
	})
}

func TestADefiniteFailureRetriesUntilTheCapThenFails(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		for range config.MailMaxAttempts + 2 {
			h.sender.Script(fakes.SendOutcome{Err: mailsetup.NotSentRetry("connection reset before DATA")})
		}
		id := h.approve("")
		stop := h.run()
		time.Sleep(3 * time.Hour)
		stop()
		email := h.email(id)
		if email.Status != domain.EmailStatusFailed || email.Attempts != config.MailMaxAttempts {
			t.Fatalf("status %v after %d attempts", email.Status, email.Attempts)
		}
		if got := h.sender.Attempts(); got != config.MailMaxAttempts {
			t.Errorf("the provider saw %d attempts, want %d", got, config.MailMaxAttempts)
		}
		if email.Error != "connection reset before DATA" {
			t.Errorf("error = %q", email.Error)
		}
	})
}

func TestARetryThatSucceedsIsSentOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		h.sender.Script(fakes.SendOutcome{Err: mailsetup.NotSentRetry("451 try later")})
		id := h.approve("")
		stop := h.run()
		time.Sleep(config.MailRetryDelay - time.Second)
		if len(h.sender.Delivered()) != 0 {
			t.Error("retried before the retry delay")
		}
		time.Sleep(time.Hour)
		stop()
		email := h.email(id)
		if email.Status != domain.EmailStatusSent || email.Attempts != 2 || len(h.sender.Delivered()) != 1 {
			t.Errorf("status %v, attempts %d, delivered %d", email.Status, email.Attempts, len(h.sender.Delivered()))
		}
	})
}

func TestARefusalFailsAtOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		h.sender.Script(fakes.SendOutcome{Err: mailsetup.NotSentRefused("535 bad password")})
		id := h.approve("")
		next := h.approve("")
		stop := h.run()
		time.Sleep(time.Hour)
		stop()
		if email := h.email(id); email.Status != domain.EmailStatusFailed || email.Attempts != 1 {
			t.Errorf("refused email: %v after %d attempts", email.Status, email.Attempts)
		}
		if h.email(next).Status != domain.EmailStatusSent {
			t.Error("the next email didn't go after a refusal")
		}
	})
}

func TestMaybeSentIsNeverResentWithoutANewApproval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		h.sender.Script(fakes.SendOutcome{Err: mailsetup.MaybeSent("timeout after the final dot"), Delivered: true})
		id := h.approve("")
		stop := h.run()
		time.Sleep(48 * time.Hour)
		email := h.email(id)
		if email.Status != domain.EmailStatusFailed || email.Error != domain.UncertainSendError {
			t.Errorf("status %v, error %q", email.Status, email.Error)
		}
		if got := len(h.sender.Delivered()); got != 1 {
			t.Errorf("delivered %d times without a new approval", got)
		}
		h.reapprove(id)
		time.Sleep(48 * time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != 2 || h.email(id).Status != domain.EmailStatusSent {
			t.Fatalf("after re-approval: delivered %d, status %v", len(delivered), h.email(id).Status)
		}
		if delivered[0].Message.MessageID != delivered[1].Message.MessageID {
			t.Error("the resend has a different Message-ID, so the recipient can't tell it is the same email")
		}
	})
}

func TestCrashMidSendBecomesMaybeSentAtStartup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		id := h.approve("")
		// What a killed process leaves behind: the email claimed, no outcome recorded.
		h.write(func(tx store.Tx) error {
			email, err := tx.Emails().Get(h.ctx, id)
			if err != nil {
				return err
			}
			sending, err := email.StartSending()
			if err != nil {
				return err
			}
			return tx.Emails().Replace(h.ctx, email, sending)
		})
		stop := h.run()
		time.Sleep(24 * time.Hour)
		stop()
		email := h.email(id)
		if email.Status != domain.EmailStatusFailed || email.Error != domain.UncertainSendError {
			t.Errorf("status %v, error %q", email.Status, email.Error)
		}
		if got := h.sender.Attempts(); got != 0 {
			t.Errorf("an email that may have gone out was sent again (%d attempts)", got)
		}
	})
}

func TestShutdownMidSendStillRecordsTheOutcome(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		release := make(chan struct{})
		h.sender.Script(fakes.SendOutcome{Block: release})
		id := h.approve("")
		ctx, cancel := context.WithCancel(h.ctx)
		done := make(chan error, 1)
		dispatcher := outbox.New(outbox.Dependencies{
			Store: cancelAwareStore{h.store}, Senders: h.service, Rules: domain.DefaultPacingRules(h.location), Now: h.now, Logger: h.logger,
		})
		go func() { done <- dispatcher.Run(ctx) }()
		synctest.Wait()
		if h.email(id).Status != domain.EmailStatusSending {
			t.Errorf("status %v, want sending", h.email(id).Status)
		}
		cancel()
		close(release)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if email := h.email(id); email.Status != domain.EmailStatusSent {
			t.Errorf("status %v after shutdown: the delivered email must not stay sending", email.Status)
		}
	})
}

func TestWakingFromSleepSendsAtTheNormalPace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 8, 30, 0, 0, mustZone(t)))
		for range 6 {
			h.approve("")
		}
		stop := h.run()
		time.Sleep(3 * time.Minute) // one goes out, the dispatcher waits for the gap
		if got := len(h.sender.Delivered()); got != 1 {
			t.Errorf("delivered %d before the sleep", got)
		}
		h.jump(5 * time.Hour) // the lid closes; on wake the wall clock is 13:35
		time.Sleep(time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != 6 {
			t.Fatalf("delivered %d", len(delivered))
		}
		assertPaced(t, delivered[1:], config.MailMinGap)
	})
}

func TestARestartAfterHoursDoesNotBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		for range 5 {
			h.approve("")
		}
		stop := h.run()
		time.Sleep(time.Minute)
		stop() // the laptop shuts down after one send
		time.Sleep(6 * time.Hour)
		stop = h.run()
		time.Sleep(time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != 5 {
			t.Fatalf("delivered %d", len(delivered))
		}
		assertPaced(t, delivered[1:], config.MailMinGap)
	})
}

func TestAClockSetBackwardsDoesNotBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 12, 0, 0, 0, mustZone(t)))
		for range 3 {
			h.approve("")
		}
		stop := h.run()
		time.Sleep(time.Second)
		h.jump(-2 * time.Hour) // the last send now looks two hours in the future
		// The domain counts a future send as "just now" on every check, so nothing more goes out
		// until the clock passes it again; then the rest go at the normal pace.
		time.Sleep(time.Hour)
		if got := len(h.sender.Delivered()); got != 1 {
			t.Errorf("delivered %d while the last send was still in the future", got)
		}
		time.Sleep(2 * time.Hour)
		stop()
		delivered := h.sender.Delivered()
		if len(delivered) != 3 {
			t.Fatalf("delivered %d", len(delivered))
		}
		assertPaced(t, delivered, config.MailMinGap)
	})
}

func TestNothingIsClaimedUntilMailIsSetUp(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		// A service over a store with no mail settings: what a fresh install looks like.
		h.service = mailsetup.NewService(mailsetup.Dependencies{Store: fakes.New(), Secrets: &fakes.SecretStore{}})
		id := h.approve("")
		stop := h.run()
		time.Sleep(time.Hour)
		stop()
		if email := h.email(id); email.Status != domain.EmailStatusApproved || email.Attempts != 0 {
			t.Errorf("status %v, attempts %d: approved mail must wait for a provider", email.Status, email.Attempts)
		}
	})
}

func TestASentFollowUpStampsTheJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 9, 0, 0, 0, mustZone(t)))
		job, err := domain.NewJob("job-1", domain.JobPatch{Company: domain.Set("Acme"), Title: domain.Set("Engineer")}, domain.WriterAgent, h.now())
		if err != nil {
			t.Fatal(err)
		}
		h.write(func(tx store.Tx) error { return tx.Jobs().Create(h.ctx, job) })
		id := h.approve("job-1")
		stop := h.run()
		time.Sleep(time.Minute)
		stop()
		var stored domain.Job
		_ = h.store.View(h.ctx, func(tx store.Tx) error {
			stored, err = tx.Jobs().Get(h.ctx, "job-1")
			return err
		})
		if sentAt := h.email(id).SentAt; sentAt.IsZero() || !stored.Followup.EmailSentAt.Equal(sentAt) {
			t.Errorf("job followup.emailSentAt = %v, email sent at %v", stored.Followup.EmailSentAt, sentAt)
		}
		logged := false
		for _, event := range h.events() {
			logged = logged || (event.JobID == "job-1" && event.Action == "Sent email" && event.Actor == domain.ActorMailer)
		}
		if !logged {
			t.Error("no activity line for the send")
		}
	})
}

func mustZone(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		t.Fatal(err)
	}
	return location
}

func TestWakingFromSleepKeepsTheWindowHonest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, time.Date(2026, 10, 8, 19, 30, 0, 0, mustZone(t)))
		id := h.approve("")
		stop := h.run()
		time.Sleep(time.Minute)
		// Asleep overnight: Go's timers don't run while the machine sleeps, so on wake the process
		// has seen one minute pass and the wall clock says 07:31. The wait for 08:00 must be
		// re-measured on the wall clock, not run out its 12.5 hours of process time.
		h.jump(12 * time.Hour)
		time.Sleep(40 * time.Minute)
		stop()
		email := h.email(id)
		if email.Status != domain.EmailStatusSent {
			t.Fatalf("status %v at 08:10 after waking", email.Status)
		}
		if local := email.SentAt.In(h.location); local.Hour() != 8 {
			t.Errorf("sent at %v", local)
		}
	})
}

// cancelAwareStore refuses work once its context is done, as a real database driver does.
type cancelAwareStore struct{ store.Store }

func (cancelAware cancelAwareStore) Atomically(ctx context.Context, work func(store.Tx) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return cancelAware.Store.Atomically(ctx, work)
}
