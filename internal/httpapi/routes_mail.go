// Outbox routes: drafting, listing, editing, approving and canceling emails; the sending status and test send.
// In the app: the Outbox page, the job and company email editors; "Email" in docs/agents-api.md.
// Used by: server.go's route table.
//
// Approve is owner-only with a passkey tap (ownerStepUp in the table). Drafting with "approve": true
// is honored only for the owner, and then it needs the same tap, for the draft route itself.

package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/domain"
)

func mailActor(caller auth.Principal) mailbox.Actor {
	return mailbox.Actor{Name: caller.Actor(), IsOwner: caller.IsOwner()}
}

// addressList is the contract's AddressList: a list, or one string split on commas, semicolons and spaces.
type addressList struct {
	set    bool
	values []string
}

func (list *addressList) UnmarshalJSON(raw []byte) error {
	list.set = true
	var many []string
	if err := json.Unmarshal(raw, &many); err == nil {
		list.values = many
		return nil
	}
	var one string
	if err := json.Unmarshal(raw, &one); err != nil {
		return &domain.ValidationError{Field: "to", Problem: "must be an address or a list of addresses"}
	}
	list.values = strings.FieldsFunc(one, func(character rune) bool {
		return character == ',' || character == ';' || character == ' ' || character == '\t'
	})
	return nil
}

type emailInput struct {
	To      addressList `json:"to"`
	Cc      addressList `json:"cc"`
	Subject *string     `json:"subject"`
	Body    *string     `json:"body"`
	Kind    string      `json:"kind"`
	Approve bool        `json:"approve"`
	JobID   string      `json:"jobId"`
}

func (input emailInput) draft() mailbox.Draft {
	draft := mailbox.Draft{To: input.To.values, Cc: input.Cc.values, Kind: domain.EmailKind(input.Kind), Approve: input.Approve}
	if input.Subject != nil {
		draft.Subject = *input.Subject
	}
	if input.Body != nil {
		draft.Body = *input.Body
	}
	return draft
}

// approveAtOnce checks the passkey tap when the owner drafts with approve: true (an agent's flag is ignored downstream).
func (server *api) approveAtOnce(r *http.Request, caller auth.Principal, input emailInput) error {
	if !input.Approve || !caller.IsOwner() {
		return nil
	}
	return server.deps.Auth.ConsumeStepUp(caller, stepUpPurpose(r), r.Header.Get(StepUpHeader)) //nolint:wrapcheck // auth sentinels
}

func (server *api) draftJobEmail(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input emailInput
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	if err := server.approveAtOnce(r, caller, input); err != nil {
		return err
	}
	email, err := server.deps.Mail.DraftForJob(r.Context(), mailActor(caller), r.PathValue("jobId"), input.draft())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, emailToJSON(email))
	return nil
}

func (server *api) draftCompanyEmail(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input emailInput
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	if err := server.approveAtOnce(r, caller, input); err != nil {
		return err
	}
	email, err := server.deps.Mail.DraftForCompany(r.Context(), mailActor(caller), r.PathValue("slug"), input.JobID, input.draft())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, emailToJSON(email))
	return nil
}

func (server *api) listEmails(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	query := r.URL.Query()
	var statuses []domain.EmailStatus
	for _, name := range strings.Split(query.Get("status"), ",") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		status, err := domain.ParseEmailStatus(name)
		if err != nil {
			return err
		}
		statuses = append(statuses, status)
	}
	list, err := server.deps.Mail.List(r.Context(), mailbox.Query{Statuses: statuses, JobID: query.Get("jobId"), CompanySlug: query.Get("company")})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, emailsToJSON(list))
	return nil
}

func (server *api) editEmail(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input emailInput
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	var edit domain.EmailEdit
	if input.To.set {
		edit.To = domain.Set(input.To.values)
	}
	if input.Cc.set {
		edit.Cc = domain.Set(input.Cc.values)
	}
	if input.Subject != nil {
		edit.Subject = domain.Set(*input.Subject)
	}
	if input.Body != nil {
		edit.Body = domain.Set(*input.Body)
	}
	email, err := server.deps.Mail.Edit(r.Context(), mailActor(caller), r.PathValue("emailId"), edit)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, emailToJSON(email))
	return nil
}

func (server *api) approveEmail(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	var input struct {
		Version *int `json:"version"`
	}
	if err := decodeInto(r, &input); err != nil {
		return err
	}
	if input.Version == nil || *input.Version < 1 {
		return &domain.ValidationError{Field: "version", Problem: "is required: the version you were shown"}
	}
	email, err := server.deps.Mail.Approve(r.Context(), mailActor(caller), r.PathValue("emailId"), *input.Version)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, emailToJSON(email))
	return nil
}

func (server *api) cancelEmail(w http.ResponseWriter, r *http.Request, caller auth.Principal) error {
	email, err := server.deps.Mail.Cancel(r.Context(), mailActor(caller), r.PathValue("emailId"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, emailToJSON(email))
	return nil
}

func (server *api) mailStatus(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	status, err := server.deps.Mail.MailStatus(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // mapped by fail
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": status.Settings.Configured, "from": status.Settings.From, "fromName": status.Settings.FromName,
		"provider": status.Settings.Provider, "bccSelf": status.Settings.BccSelf, "dailyLimit": status.DailyLimit,
		"sentToday": status.SentToday, "minGapMinutes": int(status.MinGap.Minutes()), "hours": status.Hours,
		"inWindow": status.InWindow, "lastSentAt": moment(status.LastSentAt), "nextSendAt": moment(status.NextSendAt),
		"queued": status.Queued,
	})
	return nil
}

func (server *api) sendTest(w http.ResponseWriter, r *http.Request, _ auth.Principal) error {
	id, err := server.deps.Mail.SendTest(r.Context())
	if errors.Is(err, mailbox.ErrMailNotConfigured) {
		return err //nolint:wrapcheck // mapped by fail (400)
	}
	if err != nil {
		// The provider's own words stay in the log: they can echo account details.
		slog.Warn("test email failed", "error", err)
		writeError(w, http.StatusBadGateway, errorBody{Error: "the mail provider refused the test: check the email address and the password, then try again (the server log has the provider's own words)"})
		return nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messageId": id})
	return nil
}
