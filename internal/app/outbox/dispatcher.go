// The outbox dispatcher: sends approved emails one at a time, at a human pace, and never the same one twice by itself.
// In the app: runs for the life of the server; the Outbox page shows what it did (sent, retrying, failed).
// Used by: the composition root (Phase 3) starts Run; the approve use-case may call Wake.
// Uses: store.Store (emails, events, jobs), mailsetup.Service (the sender), domain.CanSendNow (pacing), config mail knobs.
//
// Each email goes through three steps, and only the middle one touches the network:
//  1. claim: in one unit of work, the oldest approved email moves to `sending` (a compare-and-swap);
//  2. send: the adapter hands it to the provider;
//  3. record: in one unit of work, the outcome (sent, retry, failed) and its activity line.
//
// A kill between 1 and 3 leaves the email in `sending`; at the next start RecoverInterrupted moves
// it to failed with "may have been sent", and only the owner's new approval queues it again.
// Pacing state (the last send, today's count) is read from the sent rows before every send, never
// kept in memory, so a restart or a laptop waking from sleep can't cause a burst. Waits are capped
// at config.MailPollInterval because Go's timers stop while the machine sleeps.

package outbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// SenderSource builds a sender for the current mail setup; mailsetup.Service is the real one.
// Errors: mailsetup.ErrNotConfigured when there is no setup yet.
type SenderSource interface {
	Sender(ctx context.Context) (mailsetup.ReadySender, error)
}

// Dependencies are what the dispatcher needs. Zero knobs take the config defaults; Now defaults to
// time.Now, DrawJitter to a uniform draw in [0, MaxJitter], Logger to slog.Default.
type Dependencies struct {
	Store        store.Store
	Senders      SenderSource
	Rules        domain.PacingRules // window, cap, gap and zone; Jitter is drawn here
	MaxJitter    time.Duration
	MaxAttempts  int
	PollInterval time.Duration
	RetryDelay   time.Duration
	Now          func() time.Time
	DrawJitter   func(maximum time.Duration) time.Duration
	Logger       *slog.Logger
}

// Dispatcher sends the outbox. Run one per data directory (the composition root's lock).
type Dispatcher struct {
	dependencies Dependencies
	wake         chan struct{}
	jitter       time.Duration // the extra wait for the current gap, drawn after each send
}

// New builds a dispatcher; it does nothing until Run.
func New(dependencies Dependencies) *Dispatcher {
	if dependencies.MaxJitter == 0 {
		dependencies.MaxJitter = config.MailMaxJitter
	}
	if dependencies.MaxAttempts == 0 {
		dependencies.MaxAttempts = config.MailMaxAttempts
	}
	if dependencies.PollInterval <= 0 {
		dependencies.PollInterval = config.MailPollInterval
	}
	if dependencies.RetryDelay <= 0 {
		dependencies.RetryDelay = config.MailRetryDelay
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	if dependencies.DrawJitter == nil {
		dependencies.DrawJitter = drawUniformJitter
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	dispatcher := &Dispatcher{dependencies: dependencies, wake: make(chan struct{}, 1)}
	dispatcher.jitter = dispatcher.drawJitter()
	return dispatcher
}

// Wake asks the dispatcher to look at the queue now (after an approval) instead of at its next
// poll. It never bypasses pacing, and never blocks.
func (dispatcher *Dispatcher) Wake() {
	select {
	case dispatcher.wake <- struct{}{}:
	default:
	}
}

// Run recovers emails a previous run left mid-send, then sends the queue until ctx is done. A
// send in progress when ctx ends is finished and recorded (the adapters bound it); Run returns nil then.
func (dispatcher *Dispatcher) Run(ctx context.Context) error {
	if _, err := dispatcher.RecoverInterrupted(ctx); err != nil {
		return err
	}
	for {
		wait, err := dispatcher.step(ctx)
		if err != nil {
			dispatcher.dependencies.Logger.Error("outbox", "error", err.Error())
			wait = dispatcher.dependencies.PollInterval
		}
		if ctx.Err() != nil {
			return nil
		}
		if wait <= 0 {
			continue
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-dispatcher.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// RecoverInterrupted moves every email found in `sending` to failed with "may have been sent":
// the process stopped mid-send, so nobody knows whether it went out. Call it once at startup,
// before anything sends. It returns how many it moved.
func (dispatcher *Dispatcher) RecoverInterrupted(ctx context.Context) (int, error) {
	moved := 0
	err := dispatcher.dependencies.Store.Atomically(ctx, func(tx store.Tx) error {
		moved = 0
		interrupted, err := tx.Emails().ListSending(ctx)
		if err != nil {
			return fmt.Errorf("list emails left sending: %w", err)
		}
		for _, email := range interrupted {
			next, err := email.MarkSendUncertain()
			if err != nil {
				return fmt.Errorf("recover email %s: %w", email.ID, err)
			}
			if err := tx.Emails().Replace(ctx, email, next); err != nil {
				return fmt.Errorf("recover email %s: %w", email.ID, err)
			}
			if err := dispatcher.logEvent(ctx, tx, next, "Email may have been sent", "Stopped mid-send. "+domain.UncertainSendError); err != nil {
				return err
			}
			moved++
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("recover interrupted sends: %w", err)
	}
	if moved > 0 {
		dispatcher.dependencies.Logger.Warn("outbox: emails stopped mid-send need the owner", "count", moved)
	}
	return moved, nil
}

// step sends at most one email and says how long to wait before the next look.
func (dispatcher *Dispatcher) step(ctx context.Context) (time.Duration, error) {
	poll := dispatcher.dependencies.PollInterval
	waiting, err := dispatcher.queueHasMail(ctx)
	if err != nil || !waiting {
		return poll, err
	}
	ready, err := dispatcher.dependencies.Senders.Sender(ctx)
	if errors.Is(err, mailsetup.ErrNotConfigured) {
		return poll, nil // approved mail waits until the owner sets up a provider
	}
	if err != nil {
		return poll, fmt.Errorf("mail sender: %w", err)
	}
	now := dispatcher.dependencies.Now()
	decision, err := dispatcher.pacing(ctx, now, ready.DailyLimit)
	if err != nil {
		return poll, err
	}
	if !decision.Allowed() {
		if decision.NotBefore.IsZero() {
			return poll, fmt.Errorf("outbox pacing: %s", decision.Verdict)
		}
		return min(decision.NotBefore.Sub(now), poll), nil
	}
	email, claimed, err := dispatcher.claim(ctx)
	if err != nil || !claimed {
		return 0, err // a lost race or an emptied queue: look again at once
	}
	message := messageFor(email, ready.From)
	receipt, sendErr := ready.Sender.Send(ctx, message)
	// The outcome is recorded even if ctx ended meanwhile: a send that happened must not stay "sending".
	delivery, err := dispatcher.record(context.WithoutCancel(ctx), email, receipt, sendErr, ready)
	if err != nil {
		return poll, err
	}
	switch delivery {
	case outcomeSent:
		dispatcher.jitter = dispatcher.drawJitter()
		return 0, nil
	case outcomeRetry:
		return dispatcher.dependencies.RetryDelay, nil
	case outcomeFailed:
		return 0, nil
	}
	return 0, nil
}

func (dispatcher *Dispatcher) queueHasMail(ctx context.Context) (bool, error) {
	found := false
	err := dispatcher.dependencies.Store.View(ctx, func(tx store.Tx) error {
		_, err := tx.Emails().NextApproved(ctx)
		if errors.Is(err, storeerr.ErrNotFound) {
			return nil
		}
		found = err == nil
		return err // wrapped once, below, with what was being read
	})
	if err != nil {
		return false, fmt.Errorf("read the outbox: %w", err)
	}
	return found, nil
}

// pacing asks the domain rule with the history read from the sent rows.
func (dispatcher *Dispatcher) pacing(ctx context.Context, now time.Time, providerLimit int) (domain.PacingDecision, error) {
	rules := dispatcher.dependencies.Rules
	rules.Jitter = dispatcher.jitter
	if providerLimit > 0 && providerLimit < rules.DailyLimit {
		rules.DailyLimit = providerLimit
	}
	if rules.Location == nil {
		return domain.PacingDecision{}, errors.New("outbox pacing: no time zone")
	}
	var history struct {
		lastSentAt time.Time
		sentToday  int
	}
	err := dispatcher.dependencies.Store.View(ctx, func(tx store.Tx) error {
		sent, err := tx.Emails().SentHistory(ctx, domain.StartOfLocalDay(now, rules.Location))
		history.lastSentAt, history.sentToday = sent.LastSentAt, sent.SentSince
		return err // wrapped once, below, with what was being read
	})
	if err != nil {
		return domain.PacingDecision{}, fmt.Errorf("read send history: %w", err)
	}
	return domain.CanSendNow(now, history.lastSentAt, history.sentToday, rules), nil
}

// claim moves the oldest approved email to `sending` in one unit of work.
func (dispatcher *Dispatcher) claim(ctx context.Context) (domain.Email, bool, error) {
	var claimed domain.Email
	err := dispatcher.dependencies.Store.Atomically(ctx, func(tx store.Tx) error {
		email, err := tx.Emails().NextApproved(ctx)
		if err != nil {
			return fmt.Errorf("next approved email: %w", err)
		}
		next, err := email.StartSending()
		if err != nil {
			return fmt.Errorf("claim email %s: %w", email.ID, err)
		}
		if err := tx.Emails().Replace(ctx, email, next); err != nil {
			return fmt.Errorf("claim email %s: %w", email.ID, err)
		}
		claimed = next
		return nil
	})
	if errors.Is(err, storeerr.ErrNotFound) || errors.Is(err, storeerr.ErrConflict) {
		return domain.Email{}, false, nil
	}
	if err != nil {
		return domain.Email{}, false, fmt.Errorf("claim: %w", err)
	}
	return claimed, true, nil
}

// outcome is what happened to one claimed email.
type outcome int

const (
	outcomeSent outcome = iota
	outcomeRetry
	outcomeFailed
)

// record stores a send's outcome and its activity line in one unit of work.
func (dispatcher *Dispatcher) record(ctx context.Context, claimed domain.Email, receipt mailsetup.Receipt, sendErr error, ready mailsetup.ReadySender) (outcome, error) {
	now := dispatcher.dependencies.Now()
	result := outcomeSent
	err := dispatcher.dependencies.Store.Atomically(ctx, func(tx store.Tx) error {
		var next domain.Email
		var err error
		var action, detail string
		reason := ""
		if sendErr != nil {
			reason = ready.Redact(sendErr.Error())
		}
		switch delivery := mailsetup.DeliveryOf(sendErr); {
		case sendErr == nil:
			result, action, detail = outcomeSent, "Sent email", describe(claimed)
			providerID := receipt.ProviderMessageID
			if providerID == "" {
				providerID = messageFor(claimed, ready.From).MessageID
			}
			next, err = claimed.MarkSent(providerID, now)
		case delivery == mailsetup.DeliveryNotSentRetry:
			next, err = claimed.MarkSendFailed(reason, dispatcher.dependencies.MaxAttempts)
			result, action, detail = outcomeRetry, "Email not sent, will retry", reason
			if next.Status == domain.EmailStatusFailed {
				result, action = outcomeFailed, "Email failed"
			}
		case delivery == mailsetup.DeliveryNotSentRefused:
			// Not sent, and another try won't help until the owner fixes something: no attempts remain.
			next, err = claimed.MarkSendFailed(reason, claimed.Attempts)
			result, action, detail = outcomeFailed, "Email failed", reason
		default:
			next, err = claimed.MarkSendUncertain()
			result, action, detail = outcomeFailed, "Email may have been sent", domain.UncertainSendError+" ("+reason+")"
		}
		if err != nil {
			return fmt.Errorf("record email %s: %w", claimed.ID, err)
		}
		if err := tx.Emails().Replace(ctx, claimed, next); err != nil {
			return fmt.Errorf("record email %s: %w", claimed.ID, err)
		}
		if err := dispatcher.logEvent(ctx, tx, next, action, detail); err != nil {
			return err
		}
		if result == outcomeSent {
			return stampFollowupSent(ctx, tx, next)
		}
		return nil
	})
	if err != nil {
		// The email stays in `sending`; the next start's RecoverInterrupted marks it "may have been sent".
		return outcomeFailed, fmt.Errorf("record send outcome: %w", err)
	}
	dispatcher.dependencies.Logger.Info("outbox", "email", claimed.ID, "outcome", outcomeNames[result])
	return result, nil
}

var outcomeNames = map[outcome]string{outcomeSent: "sent", outcomeRetry: "will retry", outcomeFailed: "failed"}

// stampFollowupSent sets the job's followup.emailSentAt when a follow-up goes out, in the same
// unit of work. Written as the owner: the owner approved this exact email. A deleted job is skipped.
func stampFollowupSent(ctx context.Context, tx store.Tx, sent domain.Email) error {
	if sent.Kind != domain.EmailKindFollowUp || sent.JobID == "" {
		return nil
	}
	job, err := tx.Jobs().Get(ctx, sent.JobID)
	if errors.Is(err, storeerr.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stamp follow-up sent on job %s: %w", sent.JobID, err)
	}
	patch := domain.JobPatch{Followup: domain.Set(domain.FollowupPatch{EmailSentAt: domain.Set(sent.SentAt)})}
	result, err := domain.ApplyJobPatch(job, patch, domain.WriterOwner, sent.SentAt)
	if err != nil {
		return fmt.Errorf("stamp follow-up sent on job %s: %w", sent.JobID, err)
	}
	if err := tx.Jobs().Update(ctx, result.Record); err != nil {
		return fmt.Errorf("stamp follow-up sent on job %s: %w", sent.JobID, err)
	}
	return nil
}

func (dispatcher *Dispatcher) logEvent(ctx context.Context, tx store.Tx, email domain.Email, action, detail string) error {
	event, err := domain.NewEvent(email.JobID, domain.ActorMailer, action, detail, dispatcher.dependencies.Now())
	if err != nil {
		return fmt.Errorf("log %q: %w", action, err)
	}
	if _, err := tx.Events().Append(ctx, event); err != nil {
		return fmt.Errorf("log %q: %w", action, err)
	}
	return nil
}

// messageFor is the message an email becomes, with its deterministic Message-ID and idempotency key.
func messageFor(email domain.Email, from mailsetup.Address) mailsetup.Message {
	return mailsetup.Message{
		From: from, To: email.To, Cc: email.Cc, Subject: email.Subject, Body: email.Body,
		MessageID:      mailsetup.MessageIDFor(email.ID, email.Version, from.Email),
		IdempotencyKey: mailsetup.IdempotencyKeyFor(email.ID, email.Version),
	}
}

// describe is an activity line's detail for a sent email: who and what, never how.
func describe(email domain.Email) string {
	return "To " + strings.Join(email.To, ", ") + ": " + email.Subject
}

func (dispatcher *Dispatcher) drawJitter() time.Duration {
	if dispatcher.dependencies.MaxJitter <= 0 {
		return 0
	}
	return dispatcher.dependencies.DrawJitter(dispatcher.dependencies.MaxJitter)
}

// drawUniformJitter draws a wait in [0, maximum].
func drawUniformJitter(maximum time.Duration) time.Duration {
	return rand.N(maximum + 1)
}
