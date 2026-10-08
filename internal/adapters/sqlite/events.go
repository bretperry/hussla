// The events table: the append-only activity log.
// In the app: the job page's activity list, the Activity page, and what each agent key did.
// Used by: the units of work in store.go (Tx.Events); every use-case that writes.
// Uses: internal/app/events (the port).
//
// There is no update or delete here on purpose. AppendOnce uses a unique dedupe key so a seed
// imported twice adds each event once.

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/domain"
)

type eventRepository struct{ unit *unit }

var _ events.Repository = eventRepository{}

func (u *unit) Events() events.Repository { return eventRepository{unit: u} }

func (r eventRepository) Append(ctx context.Context, event domain.Event) (domain.Event, error) {
	result, err := r.unit.exec(ctx, `INSERT INTO events (jobId, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)`,
		nullable(event.JobID), requiredTimeArg(event.At), event.Actor, event.Action, event.Detail)
	if err != nil {
		return domain.Event{}, fmt.Errorf("append event: %w", err)
	}
	return withInsertedID(result, event)
}

func (r eventRepository) AppendOnce(ctx context.Context, key string, event domain.Event) (bool, error) {
	result, err := r.unit.exec(ctx, `INSERT INTO events (jobId, at, actor, action, detail, dedupeKey) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (dedupeKey) WHERE dedupeKey IS NOT NULL DO NOTHING`,
		nullable(event.JobID), requiredTimeArg(event.At), event.Actor, event.Action, event.Detail, key)
	if err != nil {
		return false, fmt.Errorf("append event once: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("append event once: %w", err)
	}
	return changed > 0, nil
}

func (r eventRepository) List(ctx context.Context, filter events.Filter) ([]domain.Event, error) {
	var conditions []string
	var args []any
	if filter.JobID != "" {
		conditions = append(conditions, "jobId = ?")
		args = append(args, filter.JobID)
	}
	if filter.Actor != "" {
		conditions = append(conditions, "actor = ?")
		args = append(args, filter.Actor)
	}
	if !filter.Since.IsZero() {
		conditions = append(conditions, "at >= ?")
		args = append(args, requiredTimeArg(filter.Since))
	}
	query := `SELECT id, jobId, at, actor, action, detail FROM events`
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = events.DefaultLimit
	}
	query += " ORDER BY at DESC, id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := r.unit.query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read cursor; rows.Err below reports failures
	var found []domain.Event
	for rows.Next() {
		var (
			event domain.Event
			jobID sql.NullString
			at    sql.NullString
		)
		if err := rows.Scan(&event.ID, &jobID, &at, &event.Actor, &event.Action, &event.Detail); err != nil {
			return nil, fmt.Errorf("list events: %w", err)
		}
		event.JobID = jobID.String
		event.At = timeFrom(at)
		found = append(found, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return found, nil
}

func withInsertedID(result sql.Result, event domain.Event) (domain.Event, error) {
	id, err := result.LastInsertId()
	if err != nil {
		return domain.Event{}, fmt.Errorf("append event: %w", err)
	}
	event.ID = id
	return event, nil
}

// nullable stores empty text as NULL (a search-wide event has no job).
func nullable(text string) any {
	if text == "" {
		return nil
	}
	return text
}
