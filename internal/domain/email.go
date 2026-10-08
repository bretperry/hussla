// Outbox emails: a draft, Bret's approval of that exact text, and its delivery, as one state machine.
// In the app: the Outbox page, the job and company email editors, and the dispatcher that sends approved mail (Phase 4).
// Used by: the email use-cases and storage (Phases 2-4).
// Uses: config.MailErrorMaxLength; address.go for recipients.
//
// States: draft → approved → sending → sent | failed; draft, approved and failed can be canceled.
// Editing an approved (or failed) email's content returns it to draft, because an approval covers
// the exact text Bret read. A send that definitely failed retries (sending → approved) until the
// attempts run out. A send that may have gone out (found in sending at startup, or cut off after
// the provider took it) goes to failed and waits for a new approval: never sent twice by itself.
// Who may do what (only the owner approves; agents edit only drafts) is the HTTP layer's rule.

package domain

import (
	"fmt"
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
	Version     int // starts at 1; every content edit bumps it, and an approval names the one it saw
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
		Kind: draft.Kind, Status: EmailStatusDraft, Version: 1, CreatedBy: draft.CreatedBy, CreatedAt: NormalizeTime(now),
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

// Edit changes a draft, approved or failed email's content. A real change bumps Version, and an
// approved or failed email goes back to draft and loses its approval; an edit that changes
// nothing (a retried save) keeps both.
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
	next.Version++
	if next.Status != EmailStatusDraft {
		next.Status = EmailStatusDraft
		next.ApprovedBy, next.ApprovedAt = "", time.Time{}
	}
	return next, nil
}

// Approve queues a draft (or a failed email, for another try) as approved by `approver`, but only
// if `seenVersion` is the version the owner was shown: if an agent edited it since, the approval
// is refused with StaleVersionError ("changed since you read it"). Storage repeats the check as a
// compare-and-swap on the row, so a race between read and write fails the same way.
func (email Email) Approve(approver string, seenVersion int, now time.Time) (Email, error) {
	if strings.TrimSpace(approver) == "" {
		return Email{}, invalid("approvedBy", "is required")
	}
	next, err := email.moveTo(EmailStatusApproved)
	if err != nil {
		return Email{}, err
	}
	if seenVersion != email.Version {
		return Email{}, &StaleVersionError{Seen: seenVersion, Current: email.Version}
	}
	next.ApprovedBy, next.ApprovedAt = approver, NormalizeTime(now)
	next.Attempts, next.Error = 0, ""
	return next, nil
}

// StaleVersionError refuses an action taken on an out-of-date view of a record; it unwraps to ErrChangedSinceRead.
type StaleVersionError struct {
	Seen    int
	Current int
}

func (staleVersionError *StaleVersionError) Error() string {
	return fmt.Sprintf("changed since you read it (you saw version %d, it is now %d): review it again", staleVersionError.Seen, staleVersionError.Current)
}

func (staleVersionError *StaleVersionError) Unwrap() error { return ErrChangedSinceRead }

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
	next.MessageID, next.SentAt, next.Error = messageID, NormalizeTime(sentAt), ""
	return next, nil
}

// MarkSendFailed records an attempt the provider definitely refused (nothing went out): back to
// approved for a retry while attempts remain (fewer than maxAttempts), failed after that.
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

// UncertainSendError is what an email shows when nobody knows whether it went out.
const UncertainSendError = "May have been sent: check your Sent folder before approving it again."

// MarkSendUncertain records a send whose outcome is unknown: the process stopped mid-send (a
// crash, a laptop lid) or the provider dropped the connection after taking the message. It goes
// to failed, never back to the queue, so it is sent again only after the owner looks and approves.
func (email Email) MarkSendUncertain() (Email, error) {
	if email.Status != EmailStatusSending {
		return Email{}, transitionError(email.Status, "record an uncertain send for")
	}
	next, err := email.moveTo(EmailStatusFailed)
	if err != nil {
		return Email{}, err
	}
	next.Error = UncertainSendError
	return next, nil
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

// validEmailContent checks the recipients and text an email will carry. A subject with CR, LF or
// NUL is refused outright: in a mail header a line break would start a new header (injection).
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
	if err := ValidateHeaderText("subject", subject); err != nil {
		return emailContent{}, err
	}
	if len(subject) > MaxSubjectLength {
		return emailContent{}, invalid("subject", "is too long")
	}
	if strings.TrimSpace(body) == "" {
		return emailContent{}, invalid("body", "is required")
	}
	return emailContent{to: toList, cc: ccList, subject: strings.TrimSpace(subject), body: body}, nil
}
