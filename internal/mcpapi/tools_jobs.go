// Job tools: find, read, create and update jobs, log an event, add a contact.
// In the app: what a search or application agent does all day; the same calls as docs/agents-api.md's job routes.
// Used by: tools.go (catalog).
// Uses: the tracker use-case with the agent as actor, and the wire decoders the HTTP routes use.
//
// Deleting a job, uploading or removing a file, and importing are owner actions and have no tool.

package mcpapi

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

var postingStatuses = []string{"open", "closed", "unknown"}

var contactProps = props{
	"priority":    str("who to try first, e.g. \"1\""),
	"name":        str("full name"),
	"role":        str("their job title"),
	"email":       str("their email address"),
	"emailStatus": enum("verified only if you saw the address on a real page; otherwise inferred", []string{"verified", "inferred"}),
	"phone":       str("phone number"),
	"linkedin":    str("LinkedIn profile URL"),
	"source":      str("URL where you found them"),
	"notes":       str("anything useful"),
}

// jobProps are the job fields an agent may send (the contract's JobPatch). null clears a field the agent last wrote.
func jobProps() props {
	nullableText := func(description string) props {
		return props{"type": []string{"string", "null"}, "description": description}
	}
	nullableInt := func(description string) props {
		return props{"type": []string{"integer", "null"}, "description": description}
	}
	return props{
		"company":              nullableText("company name"),
		"title":                nullableText("job title"),
		"status":               enum("pipeline status", config.JobStatusOrder),
		"statusNote":           nullableText("why the status is what it is"),
		"score":                nullableInt("fit score 0-100"),
		"url":                  nullableText("posting URL"),
		"location":             nullableText("e.g. Remote, US"),
		"workType":             enum("remote, hybrid or onsite", domain.WorkTypeNames()),
		"salaryMin":            nullableInt("yearly pay, low end"),
		"salaryMax":            nullableInt("yearly pay, high end"),
		"payText":              nullableText("short pay text"),
		"compensation":         nullableText("the posting's full pay text"),
		"source":               nullableText("where you found it, e.g. Greenhouse"),
		"resume":               nullableText("résumé variant planned"),
		"resumeSent":           nullableText("file actually submitted"),
		"foundAt":              nullableText("ISO timestamp"),
		"appliedAt":            nullableText("ISO timestamp (set automatically when status becomes applied)"),
		"nextAction":           nullableText("what happens next"),
		"nextActionDue":        nullableText("by when"),
		"headsUp":              nullableText("one-line warning shown at the top of the job page"),
		"description":          nullableText("full job description, markdown"),
		"descriptionFetchedAt": nullableText("ISO timestamp"),
		"postingStatus":        enum("open, closed or unknown", postingStatuses),
		"whyScore":             nullableText("scoring notes"),
		"reasons":              strList("scoring reasons (replaces the list)"),
		"scamFlags":            strList("red flags (replaces the list)"),
		"contacts":             props{"type": "array", "items": props{"type": "object", "properties": contactProps}, "description": "replaces the whole contact list; use add_contact for one"},
		"bestChannel":          nullableText("how to reach them, markdown"),
		"followup":             props{"type": "object", "description": "{to, subject, body, linkedin, callNotes, emailSentAt, linkedinSentAt, callMadeAt}; merges key by key"},
		"companyNotes":         nullableText("cliff notes on the company, markdown"),
		"roleNotes":            nullableText("cliff notes on the role, markdown"),
		"sources":              strList("URLs used (replaces the list)"),
		"notes":                nullableText("the owner's own notes; don't overwrite"),
		"note":                 str("a line for the activity timeline about this change"),
	}
}

func jobTools() []tool {
	withID := func(extra props) props {
		merged := jobProps()
		for key, value := range extra {
			merged[key] = value
		}
		return merged
	}
	return []tool{
		{
			name: "find_jobs", title: "Find jobs", route: "GET /api/jobs", readOnly: true,
			description: "List jobs, best score first. Filter by status (e.g. review,queued) or by text in the company, title or notes. Returns at most " +
				"100 jobs with total and truncated; use get_job for one job's full record.",
			schema: object(nil, props{
				"status": props{"description": "one status, a comma list (\"review,queued\"), or an array of statuses", "oneOf": []props{
					{"type": "string"}, {"type": "array", "items": props{"type": "string", "enum": config.JobStatusOrder}},
				}},
				"q": str("text to look for"),
			}),
			run: findJobs,
		},
		{
			name: "get_job", title: "Get a job", route: "GET /api/jobs/{jobId}", readOnly: true,
			description: "One job in full, with its company page, activity timeline, files and emails.",
			schema:      object([]string{"id"}, props{"id": str("the job id (a slug like acme-senior-engineer)")}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "id"); err != nil {
					return nil, err
				}
				id, err := text(args, "id", true)
				if err != nil {
					return nil, err
				}
				detail, err := env.tracker.GetJob(ctx, id)
				if err != nil {
					return nil, err //nolint:wrapcheck // mapped by describe
				}
				return jobDetailJSON(detail), nil
			},
		},
		{
			name: "create_job", title: "Add a job", route: "POST /api/jobs",
			description: "Add a new job from a search. Needs company and title. Fails if the id already exists (then use update_job). " +
				"Check find_jobs first so you don't add the same posting twice.",
			schema: object([]string{"company", "title"}, withID(props{"id": str("optional slug; made from company and title when left out")})),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				write, id, err := readJobWrite(args)
				if err != nil {
					return nil, err
				}
				job, err := env.tracker.CreateJob(ctx, env.trackerActor(), id, write)
				if err != nil {
					return nil, err
				}
				return jobJSON(job), nil
			},
		},
		{
			name: "update_job", title: "Update a job", route: "PATCH /api/jobs/{jobId}", idempotent: true,
			description: "Change a job. Send only the fields that changed; arrays replace whole, followup merges by key, null clears. " +
				"A field the owner last wrote can't be changed or cleared (the call says which); leave it out. Add note to log why in the timeline.",
			schema: object([]string{"id"}, withID(props{"id": str("the job id")})),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				id, err := text(args, "id", true)
				if err != nil {
					return nil, err
				}
				write, _, err := readJobWrite(without(args, "id"))
				if err != nil {
					return nil, err
				}
				job, err := env.tracker.PatchJob(ctx, env.trackerActor(), id, write)
				if err != nil {
					return nil, err
				}
				return jobJSON(job), nil
			},
		},
		{
			name: "add_job_event", title: "Log what you did on a job", route: "POST /api/jobs/{jobId}/events",
			description: "Add a line to a job's activity timeline, e.g. action \"Applied\" with the detail. Log what you did on every job you touch.",
			schema: object([]string{"jobId", "action"}, props{
				"jobId": str("the job id"), "action": str("short, e.g. Applied, Researched, Emailed"), "detail": str("one line of detail"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "jobId", "action", "detail"); err != nil {
					return nil, err
				}
				jobID, err := text(args, "jobId", true)
				if err != nil {
					return nil, err
				}
				action, err := text(args, "action", true)
				if err != nil {
					return nil, err
				}
				detail, err := text(args, "detail", false)
				if err != nil {
					return nil, err
				}
				event, err := env.tracker.LogEvent(ctx, env.trackerActor(), jobID, action, detail)
				if err != nil {
					return nil, err
				}
				return map[string]any{"id": event.ID}, nil
			},
		},
		{
			name: "add_contact", title: "Add a contact to a job", route: "POST /api/jobs/{jobId}/contacts", idempotent: true,
			description: "Save one contact on a job (same name and email updates it). Only mark emailStatus verified if you saw the address on a real page.",
			schema:      object([]string{"jobId", "name"}, withContact()),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				jobID, err := text(args, "jobId", true)
				if err != nil {
					return nil, err
				}
				contact, err := wire.DecodeContact(marshalObject(without(args, "jobId")))
				if err != nil {
					return nil, err
				}
				job, err := env.tracker.SaveContact(ctx, env.trackerActor(), jobID, contact)
				if err != nil {
					return nil, err
				}
				return jobJSON(job), nil
			},
		},
	}
}

func withContact() props {
	merged := props{"jobId": str("the job id")}
	for key, value := range contactProps {
		merged[key] = value
	}
	return merged
}

// readJobWrite reads a job body: the patch, the `note`, and (for create) the `id`.
func readJobWrite(args wire.Object) (tracker.JobWrite, string, error) {
	var write tracker.JobWrite
	var id string
	for key, target := range map[string]*string{"note": &write.Note, "id": &id} {
		if value, present := args[key]; present {
			content, ok := wire.Text(value)
			if !ok {
				return tracker.JobWrite{}, "", invalid(key, "must be text")
			}
			*target = content
		}
	}
	decoder := &wire.Decoder{}
	patch, err := decoder.DecodeJobPatch(args)
	if err != nil {
		return tracker.JobWrite{}, "", err
	}
	write.Patch = patch
	return write, id, nil
}

func findJobs(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
	if err := onlyKeys(args, "status", "q"); err != nil {
		return nil, err
	}
	statuses, err := statusesArg(args["status"])
	if err != nil {
		return nil, err
	}
	query, err := text(args, "q", false)
	if err != nil {
		return nil, err
	}
	list, err := env.tracker.ListJobs(ctx, tracker.JobQuery{Statuses: statuses, Text: query})
	if err != nil {
		return nil, err
	}
	total := len(list)
	if total > config.MCPFindJobsLimit {
		list = list[:config.MCPFindJobsLimit]
	}
	items := make([]wire.Object, 0, len(list))
	for _, job := range list {
		items = append(items, jobListItemJSON(job))
	}
	return map[string]any{"jobs": items, "total": total, "truncated": total > len(items)}, nil
}

// statusesArg reads "review,queued" or ["review","queued"].
func statusesArg(value json.RawMessage) ([]domain.JobStatus, error) {
	if len(value) == 0 || string(value) == "null" {
		return nil, nil
	}
	var names []string
	var many []string
	if err := json.Unmarshal(value, &many); err == nil {
		names = many
	} else {
		one, ok := wire.Text(value)
		if !ok {
			return nil, invalid("status", "must be a status, a comma list of statuses, or a list of statuses")
		}
		names = strings.Split(one, ",")
	}
	var statuses []domain.JobStatus
	for _, name := range names {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		status, err := domain.ParseJobStatus(name)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, nil
}
