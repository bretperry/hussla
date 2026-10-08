// Tests for the outbox state machine: the declared transitions exactly, each operation's effect, and the property that no sequence of operations makes an undeclared move.

package domain_test

import (
	"errors"
	"fmt"
	"testing"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

var allEmailStatuses = []domain.EmailStatus{
	domain.EmailStatusDraft, domain.EmailStatusApproved, domain.EmailStatusSending,
	domain.EmailStatusSent, domain.EmailStatusFailed, domain.EmailStatusCanceled,
}

func newTestEmail(t *testing.T) domain.Email {
	t.Helper()
	email, err := domain.NewEmail("email-1", domain.EmailDraft{
		JobID: "example-co-staff-engineer", CompanySlug: "example-co",
		To: []string{"recruiter@example.com"}, Subject: "Staff Engineer: following up", Body: "Hi there,\n\nFollowing up.",
		Kind: domain.EmailKindFollowUp, CreatedBy: domain.AgentActor("laptop"),
	}, createdAt)
	if err != nil {
		t.Fatalf("NewEmail: %v", err)
	}
	return email
}

// The transition table, spelled out: adding or removing a move must change this test too.
func TestDeclaredEmailTransitionsExactly(t *testing.T) {
	declared := map[[2]domain.EmailStatus]bool{
		{domain.EmailStatusDraft, domain.EmailStatusApproved}:    true,
		{domain.EmailStatusDraft, domain.EmailStatusCanceled}:    true,
		{domain.EmailStatusApproved, domain.EmailStatusSending}:  true,
		{domain.EmailStatusApproved, domain.EmailStatusDraft}:    true, // edited after approval
		{domain.EmailStatusApproved, domain.EmailStatusCanceled}: true,
		{domain.EmailStatusSending, domain.EmailStatusSent}:      true,
		{domain.EmailStatusSending, domain.EmailStatusFailed}:    true, // out of attempts, or may have been sent
		{domain.EmailStatusSending, domain.EmailStatusApproved}:  true, // retry after a definite failure
		{domain.EmailStatusFailed, domain.EmailStatusApproved}:   true, // approved again for another try
		{domain.EmailStatusFailed, domain.EmailStatusDraft}:      true, // edited after failing
		{domain.EmailStatusFailed, domain.EmailStatusCanceled}:   true,
	}
	for _, from := range allEmailStatuses {
		for _, to := range allEmailStatuses {
			if got := domain.CanTransition(from, to); got != declared[[2]domain.EmailStatus{from, to}] {
				t.Errorf("CanTransition(%v, %v) = %v, want %v", from, to, got, !got)
			}
		}
	}
}

func TestNewEmailValidates(t *testing.T) {
	base := domain.EmailDraft{To: []string{"a@example.com"}, Subject: "Hello", Body: "Hi", Kind: domain.EmailKindNote}
	cases := []struct {
		name  string
		edit  func(*domain.EmailDraft)
		field string
	}{
		{"no recipient", func(d *domain.EmailDraft) { d.To = nil }, "to"},
		{"bad recipient", func(d *domain.EmailDraft) { d.To = []string{"Jane <jane@example.com>"} }, "to"},
		{"bad cc", func(d *domain.EmailDraft) { d.Cc = []string{"nobody"} }, "cc"},
		{"blank subject", func(d *domain.EmailDraft) { d.Subject = " " }, "subject"},
		{"header injection", func(d *domain.EmailDraft) { d.Subject = "Hi\r\nBcc: x@evil.example" }, "subject"},
		{"blank body", func(d *domain.EmailDraft) { d.Body = "\n" }, "body"},
		{"bad kind", func(d *domain.EmailDraft) { d.Kind = "Follow Up!" }, "kind"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			draft := base
			testCase.edit(&draft)
			_, err := domain.NewEmail("e", draft, createdAt)
			var validationError *domain.ValidationError
			if !errors.As(err, &validationError) || validationError.Field != testCase.field {
				t.Fatalf("err = %v, want a ValidationError on %q", err, testCase.field)
			}
		})
	}
}

func TestEmailHappyPath(t *testing.T) {
	email := newTestEmail(t)
	if email.Status != domain.EmailStatusDraft {
		t.Fatalf("new email is %v, want draft", email.Status)
	}
	approved, err := email.Approve("Owner", email.Version, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	sending, err := approved.StartSending()
	if err != nil {
		t.Fatal(err)
	}
	if sending.Attempts != 1 {
		t.Errorf("attempts = %d, want 1", sending.Attempts)
	}
	sent, err := sending.MarkSent("<id@mail.example>", patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if sent.Status != domain.EmailStatusSent || sent.MessageID != "<id@mail.example>" || !sent.SentAt.Equal(patchedAt) {
		t.Fatalf("sent = %+v", sent)
	}
	if _, err := sent.Cancel(); !errors.Is(err, domain.ErrTransitionNotAllowed) {
		t.Fatalf("cancel a sent email: err = %v, want ErrTransitionNotAllowed", err)
	}
	if _, err := sent.Edit(domain.EmailEdit{Body: domain.Set("changed")}); !errors.Is(err, domain.ErrTransitionNotAllowed) {
		t.Fatalf("edit a sent email: err = %v, want ErrTransitionNotAllowed", err)
	}
}

func TestEditingAnApprovedEmailReturnsItToDraft(t *testing.T) {
	approved, err := newTestEmail(t).Approve("Owner", 1, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	unchanged, err := approved.Edit(domain.EmailEdit{Subject: domain.Set(approved.Subject)})
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Status != domain.EmailStatusApproved {
		t.Fatalf("an edit that changes nothing moved it to %v; a retried save must keep the approval", unchanged.Status)
	}
	edited, err := approved.Edit(domain.EmailEdit{Body: domain.Set("A different message")})
	if err != nil {
		t.Fatal(err)
	}
	if edited.Status != domain.EmailStatusDraft || edited.ApprovedBy != "" || !edited.ApprovedAt.IsZero() {
		t.Fatalf("edited approved email = %+v, want a draft with no approval", edited)
	}
}

func TestApproveRefusesAVersionTheOwnerDidNotSee(t *testing.T) {
	draft := newTestEmail(t)
	seen := draft.Version
	edited, err := draft.Edit(domain.EmailEdit{Body: domain.Set("An agent's late change")})
	if err != nil {
		t.Fatal(err)
	}
	if edited.Version != seen+1 {
		t.Fatalf("version after an edit = %d, want %d", edited.Version, seen+1)
	}
	_, err = edited.Approve("Owner", seen, patchedAt)
	var stale *domain.StaleVersionError
	if !errors.As(err, &stale) || !errors.Is(err, domain.ErrChangedSinceRead) || stale.Current != seen+1 {
		t.Fatalf("approving what the owner saw before the edit: err = %v, want StaleVersionError", err)
	}
	if _, err := edited.Approve("Owner", edited.Version, patchedAt); err != nil {
		t.Fatalf("approving the current version: %v", err)
	}
}

func TestFailedSendRetriesThenFails(t *testing.T) {
	email, err := newTestEmail(t).Approve("Owner", 1, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= config.MailMaxAttempts; attempt++ {
		if email, err = email.StartSending(); err != nil {
			t.Fatal(err)
		}
		if email, err = email.MarkSendFailed("535 auth failed", config.MailMaxAttempts); err != nil {
			t.Fatal(err)
		}
		want := domain.EmailStatusApproved
		if attempt == config.MailMaxAttempts {
			want = domain.EmailStatusFailed
		}
		if email.Status != want {
			t.Fatalf("after attempt %d: %v, want %v", attempt, email.Status, want)
		}
	}
	if email.Error != "535 auth failed" {
		t.Errorf("error = %q", email.Error)
	}
	again, err := email.Approve("Owner", email.Version, patchedAt)
	if err != nil || again.Attempts != 0 || again.Error != "" {
		t.Fatalf("re-approving a failed email: %+v, %v; want attempts and error reset", again, err)
	}
}

func TestUncertainSendNeedsNewApproval(t *testing.T) {
	email, _ := newTestEmail(t).Approve("Owner", 1, patchedAt)
	sending, _ := email.StartSending()
	uncertain, err := sending.MarkSendUncertain()
	if err != nil || uncertain.Status != domain.EmailStatusFailed || uncertain.Error != domain.UncertainSendError {
		t.Fatalf("uncertain send = %+v, %v; want failed with the check-your-Sent-folder note", uncertain, err)
	}
	if _, err := uncertain.StartSending(); !errors.Is(err, domain.ErrTransitionNotAllowed) {
		t.Fatalf("an uncertain send went back out without approval: err = %v", err)
	}
	if _, err := email.MarkSendUncertain(); !errors.Is(err, domain.ErrTransitionNotAllowed) {
		t.Fatalf("an approved email that never started sending was marked uncertain: err = %v", err)
	}
}

func TestDeliveryErrorIsCut(t *testing.T) {
	email, _ := newTestEmail(t).Approve("Owner", 1, patchedAt)
	sending, _ := email.StartSending()
	long := make([]byte, config.MailErrorMaxLength*2)
	for index := range long {
		long[index] = 'x'
	}
	failed, err := sending.MarkSendFailed(string(long), config.MailMaxAttempts)
	if err != nil || len(failed.Error) != config.MailErrorMaxLength {
		t.Fatalf("stored error is %d bytes (%v), want %d", len(failed.Error), err, config.MailErrorMaxLength)
	}
}

// emailOperation is one thing a person, agent or dispatcher can do to an email.
type emailOperation struct {
	name string
	run  func(domain.Email) (domain.Email, error)
}

var emailOperations = []emailOperation{
	{"approve", func(e domain.Email) (domain.Email, error) { return e.Approve("Owner", e.Version, patchedAt) }},
	{"approveStale", func(e domain.Email) (domain.Email, error) { return e.Approve("Owner", e.Version-1, patchedAt) }},
	{"cancel", domain.Email.Cancel},
	{"startSending", domain.Email.StartSending},
	{"markSent", func(e domain.Email) (domain.Email, error) { return e.MarkSent("id", patchedAt) }},
	{"markSendFailed", func(e domain.Email) (domain.Email, error) { return e.MarkSendFailed("boom", config.MailMaxAttempts) }},
	{"markSendUncertain", domain.Email.MarkSendUncertain},
	{"editBody", func(e domain.Email) (domain.Email, error) {
		return e.Edit(domain.EmailEdit{Body: domain.Set(e.Body + " more")})
	}},
	{"editNothing", func(e domain.Email) (domain.Email, error) { return e.Edit(domain.EmailEdit{}) }},
}

// Property: whatever operations run in whatever order, every status change is a declared
// transition, a refused operation leaves the email as it was, and sent and canceled are final.
func TestNoOperationMakesAnUndeclaredMove(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		email, err := domain.NewEmail("e", domain.EmailDraft{
			To: []string{"a@example.com"}, Subject: "Hello", Body: "Hi", Kind: domain.EmailKindNote,
		}, createdAt)
		if err != nil {
			t.Fatal(err)
		}
		steps := rapid.SliceOfN(rapid.SampledFrom(emailOperations), 1, 30).Draw(t, "operations")
		for _, step := range steps {
			next, err := step.run(email)
			if step.name == "approveStale" && err == nil {
				t.Fatalf("approved with a stale version from %v", email.Status)
			}
			if err != nil {
				if !errors.Is(err, domain.ErrTransitionNotAllowed) && !errors.Is(err, domain.ErrChangedSinceRead) {
					t.Fatalf("%s from %v: unexpected error %v", step.name, email.Status, err)
				}
				continue
			}
			if next.Status != email.Status && !domain.CanTransition(email.Status, next.Status) {
				t.Fatalf("%s moved %v → %v, which isn't declared", step.name, email.Status, next.Status)
			}
			if (email.Status == domain.EmailStatusSent || email.Status == domain.EmailStatusCanceled) && fmt.Sprint(next) != fmt.Sprint(email) {
				t.Fatalf("%s changed a %v email", step.name, email.Status)
			}
			contentChanged := next.Body != email.Body || next.Subject != email.Subject
			if contentChanged != (next.Version != email.Version) {
				t.Fatalf("%s: content changed %v but version %d → %d", step.name, contentChanged, email.Version, next.Version)
			}
			if next.Status == domain.EmailStatusApproved && next.ApprovedBy == "" {
				t.Fatalf("%s left an approved email with no approver", step.name)
			}
			email = next
		}
	})
}

func TestEmailStatusNamesRoundTrip(t *testing.T) {
	for _, status := range allEmailStatuses {
		parsed, err := domain.ParseEmailStatus(status.String())
		if err != nil || parsed != status {
			t.Errorf("%v round-trips to %v (%v)", status, parsed, err)
		}
	}
	if len(domain.EmailStatusNames()) != len(allEmailStatuses) {
		t.Errorf("EmailStatusNames has %d, want %d", len(domain.EmailStatusNames()), len(allEmailStatuses))
	}
}
