// Outbox tools: draft a follow-up or company email, and read the outbox.
// In the app: how an agent proposes an email; the owner approves or discards it on the site.
// Used by: tools.go (catalog).
// Uses: the mailbox use-case with an agent actor that is never the owner.
//
// There is no tool to approve, edit, cancel or send. A draft argument named `approve` is refused
// out loud rather than ignored, and mailActor() pins IsOwner to false so even a crafted call
// couldn't draft-and-approve in one step.

package mcpapi

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

var draftProps = props{
	"to": props{"description": "recipient address or a list; only addresses from the job's contacts (say so in body if emailStatus is inferred)", "oneOf": []props{
		{"type": "string"}, {"type": "array", "items": props{"type": "string"}},
	}},
	"cc":      props{"description": "cc address or a list", "oneOf": []props{{"type": "string"}, {"type": "array", "items": props{"type": "string"}}}},
	"subject": str("subject line"),
	"body":    str("plain-text body"),
	"kind":    str("optional label, e.g. follow-up (default for a job) or note (default for a company)"),
}

func mailTools() []tool {
	return []tool{
		{
			name: "draft_job_email", title: "Draft an email about a job", route: "POST /api/jobs/{jobId}/emails",
			description: "Write a draft for the owner to approve on the site. It is NOT sent. Check list_outbox for this job first so you don't draft the same email twice.",
			schema:      object([]string{"jobId", "to", "subject", "body"}, merge(props{"jobId": str("the job id")}, draftProps)),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				jobID, draft, err := readDraft(args, "jobId")
				if err != nil {
					return nil, err
				}
				email, err := env.mail.DraftForJob(ctx, env.mailActor(), jobID, draft)
				if err != nil {
					return nil, err
				}
				return emailToJSON(email), nil
			},
		},
		{
			name: "draft_company_email", title: "Draft an email to a company", route: "POST /api/companies/{slug}/emails",
			description: "Write a draft not tied to one job (optionally tied to one of the company's jobs) for the owner to approve. It is NOT sent.",
			schema: object([]string{"slug", "to", "subject", "body"}, merge(props{
				"slug": str("the company slug"), "jobId": str("optional: one of this company's jobs"),
			}, draftProps)),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				slug, draft, err := readDraft(args, "slug", "jobId")
				if err != nil {
					return nil, err
				}
				jobID, err := text(args, "jobId", false)
				if err != nil {
					return nil, err
				}
				email, err := env.mail.DraftForCompany(ctx, env.mailActor(), slug, jobID, draft)
				if err != nil {
					return nil, err
				}
				return emailToJSON(email), nil
			},
		},
		{
			name: "list_outbox", title: "List the outbox", route: "GET /api/emails", readOnly: true,
			description: "Emails newest first, with their status (draft, approved, sending, sent, failed, canceled). Filter by status, job or company.",
			schema: object(nil, props{
				"status":  props{"description": "one status, a comma list, or an array", "oneOf": []props{{"type": "string"}, {"type": "array", "items": props{"type": "string", "enum": domain.EmailStatusNames()}}}},
				"jobId":   str("only this job's emails"),
				"company": str("only this company's emails (slug)"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "status", "jobId", "company"); err != nil {
					return nil, err
				}
				statuses, err := emailStatusesArg(args["status"])
				if err != nil {
					return nil, err
				}
				jobID, err := text(args, "jobId", false)
				if err != nil {
					return nil, err
				}
				company, err := text(args, "company", false)
				if err != nil {
					return nil, err
				}
				list, err := env.mail.List(ctx, mailbox.Query{Statuses: statuses, JobID: jobID, CompanySlug: company})
				if err != nil {
					return nil, err
				}
				return map[string]any{"emails": emailsToJSON(list)}, nil
			},
		},
	}
}

func merge(first, second props) props {
	merged := props{}
	for key, value := range first {
		merged[key] = value
	}
	for key, value := range second {
		merged[key] = value
	}
	return merged
}

// readDraft reads the target id (the first of `target`) and the draft fields; the other names in
// target are allowed but read by the caller. An `approve` argument is refused by name.
func readDraft(args wire.Object, target ...string) (string, mailbox.Draft, error) {
	if _, asked := args["approve"]; asked {
		return "", mailbox.Draft{}, invalid("approve", "isn't available to agents: you can only draft; the owner approves on the site")
	}
	if err := onlyKeys(args, append([]string{"to", "cc", "subject", "body", "kind"}, target...)...); err != nil {
		return "", mailbox.Draft{}, err
	}
	id, err := text(args, target[0], true)
	if err != nil {
		return "", mailbox.Draft{}, err
	}
	var draft mailbox.Draft
	if draft.To, err = addresses(args, "to"); err != nil {
		return "", mailbox.Draft{}, err
	}
	if draft.Cc, err = addresses(args, "cc"); err != nil {
		return "", mailbox.Draft{}, err
	}
	if draft.Subject, err = text(args, "subject", false); err != nil {
		return "", mailbox.Draft{}, err
	}
	if draft.Body, err = text(args, "body", false); err != nil {
		return "", mailbox.Draft{}, err
	}
	kind, err := text(args, "kind", false)
	if err != nil {
		return "", mailbox.Draft{}, err
	}
	draft.Kind = domain.EmailKind(kind)
	return id, draft, nil
}

// addresses reads a list of addresses, or one string split on commas, semicolons and spaces (as the HTTP API does).
func addresses(args wire.Object, key string) ([]string, error) {
	value, present := args[key]
	if !present || string(value) == "null" {
		return nil, nil
	}
	var many []string
	if err := json.Unmarshal(value, &many); err == nil {
		return many, nil
	}
	one, ok := wire.Text(value)
	if !ok {
		return nil, invalid(key, "must be an address or a list of addresses")
	}
	return strings.FieldsFunc(one, func(character rune) bool {
		return character == ',' || character == ';' || character == ' ' || character == '\t'
	}), nil
}

func emailStatusesArg(value json.RawMessage) ([]domain.EmailStatus, error) {
	if len(value) == 0 || string(value) == "null" {
		return nil, nil
	}
	var names []string
	if err := json.Unmarshal(value, &names); err != nil {
		one, ok := wire.Text(value)
		if !ok {
			return nil, invalid("status", "must be a status, a comma list of statuses, or a list of statuses")
		}
		names = strings.Split(one, ",")
	}
	var statuses []domain.EmailStatus
	for _, name := range names {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		status, err := domain.ParseEmailStatus(name)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, nil
}
