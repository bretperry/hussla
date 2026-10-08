// The outbox as people use it: drafting, editing, approving, canceling and listing emails, and the sending status.
// In the app: the Outbox page, the job and company email editors, every agent's "draft a follow-up".
// Used by: internal/httpapi mail routes. Phase 4's dispatcher (internal/app/outbox) sends what this approves.
// Uses: store.Store (emails, events), domain email rules, the Mailer and Waker ports below.
//
// Who may do what is decided here as well as at the door: only the owner approves (and the HTTP
// layer adds the passkey tap); an agent may edit or cancel only a draft. Approval names the version
// the owner read; the domain refuses a stale one and storage repeats the check as a compare-and-swap.

package mailbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// MailSettings is what the status line shows about the configured provider.
type MailSettings struct {
	Configured bool
	From       string
	FromName   string
	Provider   string
	BccSelf    bool
}

// Mailer is the narrow slice of Phase 4's mail setup this package needs. NotConfigured stands in until then.
type Mailer interface {
	// Settings reports the provider setup (never a secret).
	Settings(ctx context.Context) (MailSettings, error)
	// SendTest sends a test email to the owner's own address now, outside pacing; it returns the provider's message id.
	SendTest(ctx context.Context) (string, error)
}

// Waker tells the dispatcher there is newly approved mail; it may ignore the hint.
type Waker interface {
	Wake()
}

// ErrMailNotConfigured: sending isn't set up yet (Settings → Mail).
var ErrMailNotConfigured = errors.New("sending isn't set up yet: add a mail provider in Settings")

// ErrAgentMayNot: an agent tried to change an email that isn't a draft, or to approve one.
var ErrAgentMayNot = errors.New("agents may only draft, and edit or cancel their drafts; the owner approves")

// NotConfigured is the Mailer before Phase 4 plugs in a real one.
type NotConfigured struct{}

// Settings reports nothing configured.
func (NotConfigured) Settings(context.Context) (MailSettings, error) { return MailSettings{}, nil }

// SendTest refuses.
func (NotConfigured) SendTest(context.Context) (string, error) { return "", ErrMailNotConfigured }

// Actor is the caller as this package needs it.
type Actor struct {
	Name    string
	IsOwner bool
}

// Service runs the mailbox use-cases.
type Service struct {
	store    store.Store
	mailer   Mailer
	waker    Waker
	location *time.Location
	now      func() time.Time
}

// Options builds a Service. Mailer defaults to NotConfigured; Location to UTC (pass config.MailTimeZone loaded).
type Options struct {
	Store    store.Store
	Mailer   Mailer
	Waker    Waker
	Location *time.Location
	Now      func() time.Time
}

// New builds the Service.
func New(options Options) *Service {
	service := &Service{store: options.Store, mailer: options.Mailer, waker: options.Waker, location: options.Location, now: options.Now}
	if service.mailer == nil {
		service.mailer = NotConfigured{}
	}
	if service.location == nil {
		service.location = time.UTC
	}
	if service.now == nil {
		service.now = time.Now
	}
	return service
}

func newEmailID() string {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	return "e" + hex.EncodeToString(buffer)
}

// Draft is a new email from the API.
type Draft struct {
	To, Cc        []string
	Subject, Body string
	Kind          domain.EmailKind // empty: follow-up for a job, note for a company
	Approve       bool             // the owner approving in the same step (the HTTP layer has checked the passkey)
}

// DraftForJob drafts an email about a job.
func (s *Service) DraftForJob(ctx context.Context, actor Actor, jobID string, draft Draft) (domain.Email, error) {
	return s.draft(ctx, actor, jobID, "", draft, domain.EmailKindFollowUp)
}

// DraftForCompany drafts an email to a company, optionally tied to one of its jobs.
func (s *Service) DraftForCompany(ctx context.Context, actor Actor, slug, jobID string, draft Draft) (domain.Email, error) {
	return s.draft(ctx, actor, jobID, slug, draft, domain.EmailKindNote)
}

func (s *Service) draft(ctx context.Context, actor Actor, jobID, slug string, draft Draft, defaultKind domain.EmailKind) (domain.Email, error) {
	if draft.Kind == "" {
		draft.Kind = defaultKind
	}
	var email domain.Email
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		now := s.now()
		if slug != "" {
			if _, err := tx.Companies().Get(ctx, slug); err != nil {
				return err
			}
		}
		if jobID != "" {
			job, err := tx.Jobs().Get(ctx, jobID)
			if err != nil {
				return err
			}
			if slug != "" && job.CompanySlug != slug {
				return &domain.ValidationError{Field: "jobId", Problem: "isn't one of this company's jobs"}
			}
			slug = job.CompanySlug
		}
		var err error
		email, err = domain.NewEmail(newEmailID(), domain.EmailDraft{
			JobID: jobID, CompanySlug: slug, To: draft.To, Cc: draft.Cc, Subject: draft.Subject, Body: draft.Body,
			Kind: draft.Kind, CreatedBy: actor.Name,
		}, now)
		if err != nil {
			return err
		}
		// Approve-at-once is the owner's only; an agent's `approve` is ignored, as the contract says.
		if draft.Approve && actor.IsOwner {
			email, err = email.Approve(actor.Name, email.Version, now)
			if err != nil {
				return err
			}
		}
		if err := tx.Emails().Create(ctx, email); err != nil {
			return err
		}
		return logEmail(ctx, tx, email, actor.Name, "Drafted email", now)
	})
	if err != nil {
		return domain.Email{}, fmt.Errorf("draft email: %w", err)
	}
	if email.Status == domain.EmailStatusApproved {
		s.wake()
	}
	return email, nil
}

func (s *Service) wake() {
	if s.waker != nil {
		s.waker.Wake()
	}
}

func logEmail(ctx context.Context, tx store.Tx, email domain.Email, actor, action string, at time.Time) error {
	event, err := domain.NewEvent(email.JobID, actor, action, email.Subject, at)
	if err != nil {
		return fmt.Errorf("event: %w", err)
	}
	if _, err := tx.Events().Append(ctx, event); err != nil {
		return fmt.Errorf("append event: %w", err)
	}
	return nil
}

// Query narrows List; empty Statuses means all.
type Query struct {
	Statuses    []domain.EmailStatus
	JobID       string
	CompanySlug string
}

// List returns the outbox, newest first.
func (s *Service) List(ctx context.Context, query Query) ([]domain.Email, error) {
	var all []domain.Email
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		all, err = tx.Emails().List(ctx, emails.Filter{JobID: query.JobID, CompanySlug: query.CompanySlug})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list emails: %w", err)
	}
	if len(query.Statuses) == 0 {
		return all, nil
	}
	matching := make([]domain.Email, 0, len(all))
	for _, email := range all {
		for _, status := range query.Statuses {
			if email.Status == status {
				matching = append(matching, email)
				break
			}
		}
	}
	return matching, nil
}

// change runs one conditional state change: read, check, compute, compare-and-swap, log.
func (s *Service) change(ctx context.Context, id, actor, action string, next func(domain.Email) (domain.Email, error)) (domain.Email, error) {
	var changed domain.Email
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Emails().Get(ctx, id)
		if err != nil {
			return err
		}
		changed, err = next(current)
		if err != nil {
			return err
		}
		if err := tx.Emails().Replace(ctx, current, changed); err != nil {
			return err
		}
		return logEmail(ctx, tx, changed, actor, action, s.now())
	})
	if err != nil {
		return domain.Email{}, fmt.Errorf("%s %s: %w", action, id, err)
	}
	return changed, nil
}

// Edit changes an email's content. Agents may edit drafts only.
func (s *Service) Edit(ctx context.Context, actor Actor, id string, edit domain.EmailEdit) (domain.Email, error) {
	return s.change(ctx, id, actor.Name, "Edited email", func(current domain.Email) (domain.Email, error) {
		if !actor.IsOwner && current.Status != domain.EmailStatusDraft {
			return domain.Email{}, ErrAgentMayNot
		}
		return current.Edit(edit)
	})
}

// Approve queues an email if `version` is still the one the owner read. Owner only.
func (s *Service) Approve(ctx context.Context, actor Actor, id string, version int) (domain.Email, error) {
	if !actor.IsOwner {
		return domain.Email{}, ErrAgentMayNot
	}
	email, err := s.change(ctx, id, actor.Name, "Approved email", func(current domain.Email) (domain.Email, error) {
		return current.Approve(actor.Name, version, s.now())
	})
	if err == nil {
		s.wake()
	}
	return email, err
}

// Cancel withdraws an email that hasn't started sending. Agents may cancel drafts only.
func (s *Service) Cancel(ctx context.Context, actor Actor, id string) (domain.Email, error) {
	return s.change(ctx, id, actor.Name, "Canceled email", func(current domain.Email) (domain.Email, error) {
		if !actor.IsOwner && current.Status != domain.EmailStatusDraft {
			return domain.Email{}, ErrAgentMayNot
		}
		return current.Cancel()
	})
}

// Status is the outbox against its pacing, for GET /api/mail.
type Status struct {
	Settings   MailSettings
	DailyLimit int
	SentToday  int
	MinGap     time.Duration
	Hours      string
	InWindow   bool
	LastSentAt time.Time
	NextSendAt time.Time
	Queued     int
}

// MailStatus reads the provider setup and the pacing state from the sent rows.
func (s *Service) MailStatus(ctx context.Context) (Status, error) {
	settings, err := s.mailer.Settings(ctx)
	if err != nil {
		return Status{}, fmt.Errorf("mail settings: %w", err)
	}
	now := s.now()
	rules := domain.DefaultPacingRules(s.location)
	status := Status{
		Settings: settings, DailyLimit: rules.DailyLimit, MinGap: rules.MinGap,
		Hours: fmt.Sprintf("%d:00–%d:00 %s", rules.WindowStartHour, rules.WindowEndHour, s.location.String()),
	}
	err = s.store.View(ctx, func(tx store.Tx) error {
		history, err := tx.Emails().SentHistory(ctx, domain.StartOfLocalDay(now, s.location))
		if err != nil {
			return err
		}
		status.SentToday, status.LastSentAt = history.SentSince, history.LastSentAt
		approved := domain.EmailStatusApproved
		queue, err := tx.Emails().List(ctx, emails.Filter{Status: &approved})
		status.Queued = len(queue)
		return err
	})
	if err != nil {
		return Status{}, fmt.Errorf("mail status: %w", err)
	}
	decision := domain.CanSendNow(now, status.LastSentAt, status.SentToday, rules)
	status.InWindow = decision.Verdict != domain.PacingOutsideWindow
	status.NextSendAt = now
	if !decision.Allowed() {
		status.NextSendAt = decision.NotBefore
	}
	return status, nil
}

// SendTest sends the test email through the configured provider. Owner only: the HTTP layer checks.
func (s *Service) SendTest(ctx context.Context) (string, error) {
	id, err := s.mailer.SendTest(ctx)
	if err != nil {
		return "", fmt.Errorf("send test: %w", err)
	}
	return id, nil
}
