// Answer, settings, stats and backup use-cases: saved form answers, the search settings agents follow, the nav counts, export and import.
// In the app: the Answers page, Settings, the dashboard badges, Settings → backup.
// Used by: internal/httpapi.

package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/importseed"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// ListAnswers returns saved answers, unanswered first, then oldest first.
func (s *Service) ListAnswers(ctx context.Context) ([]domain.Answer, error) {
	var list []domain.Answer
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		list, err = tx.Answers().List(ctx)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list answers: %w", err)
	}
	slices.SortStableFunc(list, func(left, right domain.Answer) int {
		switch {
		case left.IsUnanswered() == right.IsUnanswered():
			return 0
		case left.IsUnanswered():
			return -1
		default:
			return 1
		}
	})
	return list, nil
}

// SaveAnswer creates the answer at id (the question's slug when id is empty), or patches it when
// it exists. created says which.
func (s *Service) SaveAnswer(ctx context.Context, actor Actor, id string, patch domain.AnswerPatch) (domain.Answer, bool, error) {
	if id == "" {
		derived, ok := domain.AnswerIDFor(patch.Question.Value())
		if !ok {
			return domain.Answer{}, false, &domain.ValidationError{Field: "id", Problem: "can't be made from the question; send one"}
		}
		id = derived
	}
	var answer domain.Answer
	created := false
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		now := s.now()
		current, err := tx.Answers().Get(ctx, id)
		if errors.Is(err, storeerr.ErrNotFound) {
			created = true
			answer, err = domain.NewAnswer(id, patch, actor.Writer, now)
			if err != nil {
				return err
			}
			if err := tx.Answers().Create(ctx, answer); err != nil {
				return err
			}
			_, err = logEvent(ctx, tx, "", actor.Name, "Saved question", answer.Question, now)
			return err
		}
		if err != nil {
			return err
		}
		result, err := domain.ApplyAnswerPatch(current, patch, actor.Writer, now)
		if err != nil {
			return err
		}
		answer = result.Record
		if len(result.Changed) == 0 {
			return nil
		}
		if err := tx.Answers().Update(ctx, answer); err != nil {
			return err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Updated answer", changeDetail(actor.Writer, result.Changed, wire.AnswerObject(result.Before)), now)
		return err
	})
	if err != nil {
		return domain.Answer{}, false, fmt.Errorf("save answer %s: %w", id, err)
	}
	return answer, created, nil
}

// DeleteAnswer removes a saved answer; found is false when there was none. Owner only: the HTTP layer checks.
func (s *Service) DeleteAnswer(ctx context.Context, actor Actor, id string) (bool, error) {
	found := true
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		answer, err := tx.Answers().Get(ctx, id)
		if errors.Is(err, storeerr.ErrNotFound) {
			found = false
			return nil
		}
		if err != nil {
			return err
		}
		if err := tx.Answers().Delete(ctx, id); err != nil {
			return err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Deleted answer", answer.Question, s.now())
		return err
	})
	if err != nil {
		return false, fmt.Errorf("delete answer %s: %w", id, err)
	}
	return found, nil
}

// SearchConfig returns the search settings agents follow (an empty object when none are stored).
func (s *Service) SearchConfig(ctx context.Context) (wire.Object, error) {
	object := wire.Object{}
	err := s.store.View(ctx, func(tx store.Tx) error {
		text, err := tx.Settings().Get(ctx, settings.KeySearchConfig)
		if errors.Is(err, storeerr.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(text), &object); err != nil {
			return fmt.Errorf("stored search config is damaged: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read search config: %w", err)
	}
	return object, nil
}

// PatchSearchConfig merges named top-level keys (null removes one) and stamps updatedAt. Owner only: the HTTP layer checks.
func (s *Service) PatchSearchConfig(ctx context.Context, actor Actor, patch wire.Object) (wire.Object, error) {
	var merged wire.Object
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		merged = wire.Object{}
		text, err := tx.Settings().Get(ctx, settings.KeySearchConfig)
		switch {
		case err == nil:
			if err := json.Unmarshal([]byte(text), &merged); err != nil {
				return fmt.Errorf("stored search config is damaged: %w", err)
			}
		case !errors.Is(err, storeerr.ErrNotFound):
			return err
		}
		var names []string
		for key, value := range patch {
			if key == "updatedAt" {
				continue
			}
			names = append(names, key)
			if string(bytes.TrimSpace(value)) == "null" {
				delete(merged, key)
				continue
			}
			merged[key] = value
		}
		merged["updatedAt"] = json.RawMessage(`"` + domain.FormatTimestamp(s.now()) + `"`)
		encoded, err := json.Marshal(merged)
		if err != nil {
			return fmt.Errorf("encode search config: %w", err)
		}
		if err := tx.Settings().Set(ctx, settings.KeySearchConfig, string(encoded)); err != nil {
			return err
		}
		slices.Sort(names)
		_, err = logEvent(ctx, tx, "", actor.Name, "Changed search settings", strings.Join(names, ", "), s.now())
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("patch search config: %w", err)
	}
	return merged, nil
}

// Stats are the nav badges' counts.
type Stats struct {
	Total      int
	ByStatus   map[domain.JobStatus]int
	Unanswered int
	Drafts     int
}

// Stats counts jobs by status, unanswered questions and email drafts.
func (s *Service) Stats(ctx context.Context) (Stats, error) {
	stats := Stats{ByStatus: map[domain.JobStatus]int{}}
	err := s.store.View(ctx, func(tx store.Tx) error {
		all, err := tx.Jobs().List(ctx, jobs.Filter{})
		if err != nil {
			return err
		}
		stats.Total = len(all)
		for _, job := range all {
			stats.ByStatus[job.Status]++
		}
		answers, err := tx.Answers().List(ctx)
		if err != nil {
			return err
		}
		for _, answer := range answers {
			if answer.IsUnanswered() {
				stats.Unanswered++
			}
		}
		draft := domain.EmailStatusDraft
		drafts, err := tx.Emails().List(ctx, emails.Filter{Status: &draft})
		stats.Drafts = len(drafts)
		return err
	})
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	return stats, nil
}

// Export is everything a bundle holds, for GET /api/export. Encoding is the HTTP layer's.
type Export struct {
	Config    wire.Object
	Jobs      []domain.Job
	Companies []domain.Company
	Answers   []domain.Answer
	Events    []domain.Event
}

// exportEventLimit is how many activity lines a backup carries (the whole log for one person's search).
const exportEventLimit = 1_000_000

// ExportAll reads everything in one snapshot.
func (s *Service) ExportAll(ctx context.Context) (Export, error) {
	config, err := s.SearchConfig(ctx)
	if err != nil {
		return Export{}, err
	}
	bundle := Export{Config: config}
	err = s.store.View(ctx, func(tx store.Tx) error {
		var err error
		if bundle.Jobs, err = tx.Jobs().List(ctx, jobs.Filter{}); err != nil {
			return err
		}
		if bundle.Companies, err = tx.Companies().List(ctx); err != nil {
			return err
		}
		if bundle.Answers, err = tx.Answers().List(ctx); err != nil {
			return err
		}
		bundle.Events, err = tx.Events().List(ctx, events.Filter{Limit: exportEventLimit})
		return err
	})
	if err != nil {
		return Export{}, fmt.Errorf("export: %w", err)
	}
	return bundle, nil
}

// Import loads a backup or seed bundle (existing records win). Owner only: the HTTP layer checks.
func (s *Service) Import(ctx context.Context, actor Actor, body []byte) (importseed.Report, error) {
	report, err := importseed.Import(ctx, s.store, bytes.NewReader(body), s.now())
	if err != nil {
		return importseed.Report{}, fmt.Errorf("import: %w", err)
	}
	created := report.Jobs.Created + report.Companies.Created + report.Answers.Created + report.Events.Created + report.Emails.Created
	if created == 0 && !report.ConfigStored {
		return report, nil // a repeat import adds nothing, not even a log line
	}
	detail := fmt.Sprintf("%d jobs, %d companies, %d answers, %d events, %d emails", report.Jobs.Created, report.Companies.Created, report.Answers.Created, report.Events.Created, report.Emails.Created)
	if _, err := s.LogEvent(ctx, actor, "", "Imported a bundle", detail); err != nil {
		return report, err
	}
	return report, nil
}
