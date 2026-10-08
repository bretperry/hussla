// Activity events: the timeline of who did what, on a job or across the whole search.
// In the app: the job page's activity list, the Activity page, and the audit trail of what each agent key did.
// Used by: every use-case that writes (Phases 2-4); storage keeps them append-only.

package domain

import (
	"strings"
	"time"
)

// Actors the server itself writes as. People appear by display name; agents as "agent:<key name>".
const (
	ActorSystem = "system"
	ActorMailer = "mailer"
	ActorImport = "import"
)

// agentActorPrefix marks an actor as an agent key, so the log tells Bret's own actions from an agent's.
const agentActorPrefix = "agent:"

// Event text caps: an action is a short verb phrase; a detail is a sentence or two, not a document.
const (
	MaxEventActionLength = 200
	MaxEventDetailLength = 5000
)

// Event is one line in the activity log. JobID is empty for a search-wide event ("Ran search").
type Event struct {
	ID     int64
	JobID  string
	At     time.Time
	Actor  string
	Action string
	Detail string
}

// AgentActor is how an agent key is named in the log ("agent:laptop-search").
func AgentActor(keyName string) string { return agentActorPrefix + keyName }

// IsAgentActor is true for an actor written by an agent key.
func IsAgentActor(actor string) bool { return strings.HasPrefix(actor, agentActorPrefix) }

// NewEvent builds a log line; an action is required, and over-long text is cut rather than refused,
// because a log line that fails to write is worse than a shortened one.
func NewEvent(jobID, actor, action, detail string, at time.Time) (Event, error) {
	action = strings.TrimSpace(action)
	if action == "" {
		return Event{}, invalid("action", "is required")
	}
	if strings.TrimSpace(actor) == "" {
		actor = ActorSystem
	}
	return Event{
		JobID:  jobID,
		At:     NormalizeTime(at),
		Actor:  actor,
		Action: truncateUTF8(action, MaxEventActionLength),
		Detail: truncateUTF8(detail, MaxEventDetailLength),
	}, nil
}

// StatusChangeDetail is the log detail for a status move ("review → applied").
func StatusChangeDetail(change JobStatusChange) string {
	return change.From.String() + " → " + change.To.String()
}
