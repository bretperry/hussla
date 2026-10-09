// Outbox import: the prototype's emails, brought in as history or as drafts that wait for a new approval.
// In the app: the move from the prototype ("Import from the old tracker", `hussla import`), when the file has an `emails` list.
// Used by: importseed.go.
// Uses: internal/domain (an email's rules and states), internal/app/store (the emails, jobs and companies it links to).
//
// Nothing imported is ever sent: no email lands `approved`, and the dispatcher only picks up
// approved mail. A sent email is history (it keeps its sent time and the approval it went out
// under). One that was a draft, approved or failed in the prototype lands as a draft with no
// approval, so it goes out only after the owner approves it again in Hussla. One caught
// mid-send lands as failed with UncertainSendError: it may already have gone out, so the owner
// checks their Sent folder before approving it. Canceled stays canceled.

package importseed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// emailJSON is one row of the prototype's outbox as GET /api/emails (and an export's `emails`) wrote it.
type emailJSON struct {
	ID          string   `json:"id"`
	JobID       *string  `json:"jobId"`
	CompanySlug *string  `json:"companySlug"`
	To          []string `json:"to"`
	Cc          []string `json:"cc"`
	Subject     string   `json:"subject"`
	Body        string   `json:"body"`
	Kind        string   `json:"kind"`
	Status      string   `json:"status"`
	CreatedBy   string   `json:"createdBy"`
	CreatedAt   string   `json:"createdAt"`
	ApprovedBy  *string  `json:"approvedBy"`
	ApprovedAt  *string  `json:"approvedAt"`
	SentAt      *string  `json:"sentAt"`
	MessageID   *string  `json:"messageId"`
	Attempts    int      `json:"attempts"`
}

func (i *importer) importEmail(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("email #%d", index+1)
	var seeded emailJSON
	if err := json.Unmarshal(record, &seeded); err != nil {
		i.report.Emails.Skipped++
		i.warn(where, "not an email object; skipped")
		return nil
	}
	id := strings.TrimSpace(seeded.ID)
	if id == "" {
		i.report.Emails.Skipped++
		i.warn(where, "has no id; skipped")
		return nil
	}
	where += " (" + seeded.Subject + ")"
	if _, err := tx.Emails().Get(ctx, id); err == nil {
		i.report.Emails.Skipped++
		return nil
	} else if !errors.Is(err, storeerr.ErrNotFound) {
		return fmt.Errorf("look up email %s: %w", id, err)
	}
	jobID, slug, err := i.emailLinks(ctx, tx, where, seeded)
	if err != nil {
		return err
	}
	kind := domain.EmailKind(strings.TrimSpace(seeded.Kind))
	if kind == "" {
		kind = domain.EmailKindFollowUp
	} else if kind.Validate() != nil {
		i.warn(where, "kind %q isn't one Hussla accepts; imported as %q", seeded.Kind, domain.EmailKindNote)
		kind = domain.EmailKindNote
	}
	createdAt := i.timeOr(where, "createdAt", seeded.CreatedAt, i.now)
	email, err := domain.NewEmail(id, domain.EmailDraft{
		JobID: jobID, CompanySlug: slug, To: seeded.To, Cc: seeded.Cc, Subject: seeded.Subject, Body: seeded.Body,
		Kind: kind, CreatedBy: seeded.CreatedBy,
	}, createdAt)
	if err != nil {
		i.report.Emails.Skipped++
		i.warn(where, "%v; skipped", err)
		return nil
	}
	i.applyEmailStatus(where, &email, seeded)
	if err := tx.Emails().Create(ctx, email); err != nil {
		return fmt.Errorf("store email %s: %w", id, err)
	}
	i.report.Emails.Created++
	return nil
}

// applyEmailStatus maps the prototype's outbox state onto one that can never send by itself.
func (i *importer) applyEmailStatus(where string, email *domain.Email, seeded emailJSON) {
	switch seeded.Status {
	case "sent":
		email.Status = domain.EmailStatusSent
		email.SentAt = i.timeOr(where, "sentAt", deref(seeded.SentAt), email.CreatedAt)
		email.ApprovedBy = deref(seeded.ApprovedBy)
		email.ApprovedAt = i.timeOr(where, "approvedAt", deref(seeded.ApprovedAt), time.Time{})
		email.MessageID = deref(seeded.MessageID)
		email.Attempts = max(seeded.Attempts, 1)
	case "canceled":
		email.Status = domain.EmailStatusCanceled
	case "sending":
		email.Status = domain.EmailStatusFailed
		email.Error = domain.UncertainSendError
		i.report.NeedApproval++
	case "draft", "approved", "failed":
		i.report.NeedApproval++ // stays the draft NewEmail made: no approval carried over
	default:
		i.warn(where, "status %q isn't one Hussla knows; imported as an unapproved draft", seeded.Status)
		i.report.NeedApproval++
	}
}

// emailLinks keeps the email's job and company when they exist here, and says when one doesn't.
func (i *importer) emailLinks(ctx context.Context, tx store.Tx, where string, seeded emailJSON) (jobID, slug string, err error) {
	if wanted := strings.TrimSpace(deref(seeded.JobID)); wanted != "" {
		job, err := tx.Jobs().Get(ctx, wanted)
		switch {
		case err == nil:
			return job.ID, job.CompanySlug, nil
		case !errors.Is(err, storeerr.ErrNotFound):
			return "", "", fmt.Errorf("look up job %s: %w", wanted, err)
		}
		i.warn(where, "its job %q isn't here; imported without a job", wanted)
	}
	if wanted := strings.TrimSpace(deref(seeded.CompanySlug)); wanted != "" {
		_, err := tx.Companies().Get(ctx, wanted)
		switch {
		case err == nil:
			return "", wanted, nil
		case !errors.Is(err, storeerr.ErrNotFound):
			return "", "", fmt.Errorf("look up company %s: %w", wanted, err)
		}
		i.warn(where, "its company %q isn't here; imported without a company", wanted)
	}
	return "", "", nil
}

// timeOr reads an RFC 3339 time, or returns fallback (with a warning when the text was there but unreadable).
func (i *importer) timeOr(where, field, text string, fallback time.Time) time.Time {
	parsed, err := domain.ParseTimestamp(text)
	if err != nil {
		i.warn(where, "%s %q isn't a readable time; ignored", field, text)
		return fallback
	}
	if parsed.IsZero() {
		return fallback
	}
	return parsed
}

func deref(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}
