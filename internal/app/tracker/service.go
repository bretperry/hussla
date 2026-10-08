// The tracker use-cases: jobs, companies, contacts, news, reviews, answers, activity, search settings, stats, export and import.
// In the app: every page but the outbox and Settings → keys; every agent's reads and writes.
// Used by: internal/httpapi (and Phase 3b's MCP tools: same use-cases, so permissions can't drift).
// Uses: store.Store (one unit of work per write), internal/domain rules, internal/app/wire for JSON-shaped values.
//
// Each write is: read inside the unit of work, apply the domain rule as the caller's writer (owner
// or agent: an agent can't change what the owner last wrote), store, and log what changed in the
// same unit of work. An agent's change logs the values it replaced, so the owner can put them back.

package tracker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// Actor is who is writing: the activity log's name and the patch writer. The HTTP layer builds it
// from an auth.Principal; it is never read from the request body.
type Actor struct {
	Name   string
	Writer domain.Writer
}

// Service runs the tracker use-cases.
type Service struct {
	store store.Store
	now   func() time.Time
}

// New builds the Service; now is time.Now when nil.
func New(target store.Store, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{store: target, now: now}
}

// logEvent appends one activity line inside a unit of work.
func logEvent(ctx context.Context, tx store.Tx, jobID, actor, action, detail string, at time.Time) (domain.Event, error) {
	event, err := domain.NewEvent(jobID, actor, action, detail, at)
	if err != nil {
		return domain.Event{}, fmt.Errorf("event: %w", err)
	}
	stored, err := tx.Events().Append(ctx, event)
	if err != nil {
		return domain.Event{}, fmt.Errorf("append event: %w", err)
	}
	return stored, nil
}

// changeDetail names the changed fields, and for an agent the values they had before (from the
// record's API object), so the owner can restore them from the log.
func changeDetail(writer domain.Writer, changed []string, before wire.Object) string {
	if len(changed) == 0 {
		return ""
	}
	detail := strings.Join(changed, ", ")
	if writer != domain.WriterAgent || before == nil {
		return detail
	}
	prior := map[string]json.RawMessage{}
	for _, name := range changed {
		key, _, _ := strings.Cut(name, ".")
		if value, found := before[key]; found {
			prior[key] = value
		}
	}
	encoded, err := json.Marshal(prior)
	if err != nil {
		return detail
	}
	return detail + "\nbefore: " + string(encoded)
}
