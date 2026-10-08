// Outbox emails: a draft, Bret's approval of that exact text, and its delivery, as one state machine.
// In the app: the Outbox page, the job and company email editors, and the dispatcher that sends approved mail (Phase 4).
// Used by: the email use-cases and storage (Phases 2-4).
// Uses: config.MailErrorMaxLength; address.go for recipients.
//
// States: draft → approved → sending → sent | failed; draft, approved and failed can be canceled.
// Editing an approved (or failed) email's content returns it to draft, because an approval covers
// the exact text Bret read. A failed send retries (sending → approved) until the attempts run out.
// A crash mid-send also returns it to approved: the dispatcher re-queues "sending" rows on start.
// Who may do what (only the owner approves; agents edit only drafts) is the HTTP layer's rule.

package domain

import (
	"slices"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/config"
)

// EmailStatus is where an email is in the outbox.
type EmailStatus int

const (
	EmailStatusDraft EmailStatus = iota
	EmailStatusApproved
	EmailStatusSending
	EmailStatusSent
	EmailStatusFailed
	EmailStatusCanceled
)

var emailStatusNames = []string{"draft", "approved", "sending", "sent", "failed", "canceled"}

func (status EmailStatus) String() string { return enumName(emailStatusNames, status) }

// ParseEmailStatus reads an API spelling.
func ParseEmailStatus(text string) (EmailStatus, error) {
	status, ok := parseEnum[EmailStatus](emailStatusNames, text)
	if !ok {
		return EmailStatusDraft, invalid("status", "unknown email status "+`"`+text+`"; use one of: `+strings.Join(emailStatusNames, ", "))
	}
	return status, nil
}

// EmailStatusNames lists every API spelling, for the contract.
func EmailStatusNames() []string { return append([]string(nil), emailStatusNames...) }

// emailTransitions is every move the outbox allows; anything not listed is refused.
var emailTransitions = map[EmailStatus][]EmailStatus{
	EmailStatusDraft:    {EmailStatusApproved, EmailStatusCanceled},
	EmailStatusApproved: {EmailStatusSending, EmailStatusDraft, EmailStatusCanceled},
	EmailStatusSending:  {EmailStatusSent, EmailStatusFailed, EmailStatusApproved},
	EmailStatusSent:     {},
	EmailStatusFailed:   {EmailStatusApproved, EmailStatusDraft, EmailStatusCanceled},
	EmailStatusCanceled: {},
}

// CanTransition reports whether the outbox allows moving an email from one status to another.
func CanTransition(from, to EmailStatus) bool {
	for _, allowed := range emailTransitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// EmailKind says what an email is for. A sent follow-up stamps the job's followup.emailSentAt.
// It is open-ended (agents name new kinds), but always a short lowercase word or hyphenated phrase.
type EmailKind string

const (
	EmailKindFollowUp EmailKind = "follow-up"
	EmailKindNote     EmailKind = "note"
)

// MaxEmailKindLength caps a kind's spelling.
const MaxEmailKindLength = 40

// Validate accepts 1-MaxEmailKindLength lowercase letters, digits and hyphens.
func (kind EmailKind) Validate() error {
	if kind == "" || len(kind) > MaxEmailKindLength || !IsValidRecordID(string(kind)) {
		return invalid("kind", `must be a short lowercase word like "follow-up"`)
	}
	return nil
}

// Email is one message in the outbox. JobID is empty for a company email not tied to a job.
type Email struct {
	ID          string
	JobID       string
	CompanySlug string
	To          []string
	Cc          []string
	Subject     string
	Body        string // plain text
	Kind        EmailKind
	Status      EmailStatus
	CreatedBy   string // actor
	CreatedAt   time.Time
	ApprovedBy  string
	ApprovedAt  time.Time
	SentAt      time.Time
	MessageID   string // the provider's id for the sent message
	Error       string // the last delivery error, cut to config.MailErrorMaxLength
	Attempts    int
}

// EmailDraft is what a new email starts from.
type EmailDraft struct {
	JobID       string
	CompanySlug string
	To          []string
	Cc          []string
	Subject     string
	Body        string
	Kind        EmailKind
	CreatedBy   string
}

// NewEmail validates a draft and records it as a draft; approving is a separate step, by the owner.
func NewEmail(id string, draft EmailDraft, now time.Time) (Email, error) {
	if strings.TrimSpace(id) == "" {
		return Email{}, invalid("id", "is required")
	}
	email := Email{
		ID: id, JobID: draft.JobID, CompanySlug: draft.CompanySlug,
		Kind: draft.Kind, Status: EmailStatusDraft, CreatedBy: draft.CreatedBy, CreatedAt: now.UTC(),
	}
	if err := draft.Kind.Validate(); err != nil {
		return Email{}, err
	}
	content, err := validEmailContent(draft.To, draft.Cc, draft.Subject, draft.Body)
	if err != nil {
		return Email{}, err
	}
	email.To, email.Cc, email.Subject, email.Body = content.to, content.cc, content.subject, content.body
	return email, nil
}

// EmailEdit names the content fields one edit changes.
type EmailEdit struct {
	To      Field[[]string]
	Cc      Field[[]string]
	Subject Field[string]
	Body    Field[string]
}

// Edit changes a draft, approved or failed email's content. When the content actually differs
// and the email isn't a draft, it goes back to draft and loses its approval; an edit that changes
// nothing (a retried save) keeps the approval.
func (email Email) Edit(edit EmailEdit) (Email, error) {
	if email.Status != EmailStatusDraft && !CanTransition(email.Status, EmailStatusDraft) {
		return Email{}, transitionError(email.Status, "edit")
	}
	content, err := validEmailContent(
		edit.To.Apply(email.To), edit.Cc.Apply(email.Cc), edit.Subject.Apply(email.Subject), edit.Body.Apply(email.Body),
	)
	if err != nil {
		return Email{}, err
	}
	changed := !slices.Equal(content.to, email.To) || !slices.Equal(content.cc, email.Cc) ||
		content.subject != email.Subject || content.body != email.Body
	if !changed {
		return email, nil
	}
	next := email
	next.To, next.Cc, next.Subject, next.Body = content.to, content.cc, content.subject, content.body
	if next.Status != EmailStatusDraft {
		next.Status = EmailStatusDraft
		next.ApprovedBy, next.ApprovedAt = "", time.Time{}
	}
	return next, nil
}

// Approve queues a draft (or a failed email, for another try) for sending, as approved by `approver`.
func (email Email) Approve(approver string, now time.Time) (Email, error) {
	if strings.TrimSpace(approver) == "" {
		return Email{}, invalid("approvedBy", "is required")
	}
	next, err := email.moveTo(EmailStatusApproved)
	if err != nil {
		return Email{}, err
	}
	next.ApprovedBy, next.ApprovedAt = approver, now.UTC()
	next.Attempts, next.Error = 0, ""
	return next, nil
}

// Cancel withdraws an email that hasn't started sending.
func (email Email) Cancel() (Email, error) { return email.moveTo(EmailStatusCanceled) }

// StartSending claims an approved email for one delivery attempt.
func (email Email) StartSending() (Email, error) {
	next, err := email.moveTo(EmailStatusSending)
	if err != nil {
		return Email{}, err
	}
	next.Attempts++
	return next, nil
}

// MarkSent records a delivery the provider accepted.
func (email Email) MarkSent(messageID string, sentAt time.Time) (Email, error) {
	next, err := email.moveTo(EmailStatusSent)
	if err != nil {
		return Email{}, err
	}
	next.MessageID, next.SentAt, next.Error = messageID, sentAt.UTC(), ""
	return next, nil
}

// MarkSendFailed records a failed attempt: back to approved for a retry while attempts remain
// (fewer than maxAttempts), failed after that.
func (email Email) MarkSendFailed(deliveryError string, maxAttempts int) (Email, error) {
	if email.Status != EmailStatusSending {
		return Email{}, transitionError(email.Status, "record a failed send for")
	}
	target := EmailStatusApproved
	if email.Attempts >= maxAttempts {
		target = EmailStatusFailed
	}
	next, err := email.moveTo(target)
	if err != nil {
		return Email{}, err
	}
	next.Error = truncateUTF8(deliveryError, config.MailErrorMaxLength)
	return next, nil
}

// Requeue returns an email a crash left in sending to the queue; its attempt still counts.
// Only from sending: approved is also reachable from draft, and that move is the owner's Approve.
func (email Email) Requeue() (Email, error) {
	if email.Status != EmailStatusSending {
		return Email{}, transitionError(email.Status, "requeue")
	}
	return email.moveTo(EmailStatusApproved)
}

// moveTo applies one declared transition, or refuses with ErrTransitionNotAllowed.
func (email Email) moveTo(target EmailStatus) (Email, error) {
	if !CanTransition(email.Status, target) {
		return Email{}, transitionError(email.Status, target.String())
	}
	next := email
	next.Status = target
	return next, nil
}

// TransitionError says what was refused and from which state, and unwraps to ErrTransitionNotAllowed.
type TransitionError struct {
	From   EmailStatus
	Action string
}

func (transitionError *TransitionError) Error() string {
	return "can't " + transitionError.Action + " an email that is " + transitionError.From.String()
}

func (transitionError *TransitionError) Unwrap() error { return ErrTransitionNotAllowed }

func transitionError(from EmailStatus, action string) error {
	return &TransitionError{From: from, Action: action}
}

// emailContent is validated recipients, subject and body.
type emailContent struct {
	to, cc        []string
	subject, body string
}

// MaxSubjectLength caps a subject line; mail servers fold longer ones and recruiters never read them.
const MaxSubjectLength = 300

// validEmailContent checks the recipients and text an email will carry. A subject with a line
// break is refused outright: in a mail header it would start a new header (injection).
func validEmailContent(to, cc []string, subject, body string) (emailContent, error) {
	toList, err := ValidateAddresses("to", to)
	if err != nil {
		return emailContent{}, err
	}
	if len(toList) == 0 {
		return emailContent{}, invalid("to", "needs at least one address")
	}
	ccList, err := ValidateAddresses("cc", cc)
	if err != nil {
		return emailContent{}, err
	}
	if strings.TrimSpace(subject) == "" {
		return emailContent{}, invalid("subject", "is required")
	}
	if strings.ContainsAny(subject, "\r\n") {
		return emailContent{}, invalid("subject", "must be one line")
	}
	if len(subject) > MaxSubjectLength {
		return emailContent{}, invalid("subject", "is too long")
	}
	if strings.TrimSpace(body) == "" {
		return emailContent{}, invalid("body", "is required")
	}
	return emailContent{to: toList, cc: ccList, subject: strings.TrimSpace(subject), body: body}, nil
}
