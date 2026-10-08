// Job use-cases: list, read, create, patch, upsert, delete, a job's activity line and contacts.
// In the app: the jobs table, the job page, and the calls in docs/agents-api.md ("New job from a search", "Submitted an application").
// Used by: internal/httpapi job routes.

package tracker

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// JobQuery narrows ListJobs. Empty Statuses means every status.
type JobQuery struct {
	Statuses []domain.JobStatus
	Text     string
}

// ListJobs returns matching jobs, best score first (unscored last), then most recently updated.
func (s *Service) ListJobs(ctx context.Context, query JobQuery) ([]domain.Job, error) {
	var all []domain.Job
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		all, err = tx.Jobs().List(ctx, jobs.Filter{})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	text := strings.ToLower(strings.TrimSpace(query.Text))
	matching := make([]domain.Job, 0, len(all))
	for _, job := range all {
		if len(query.Statuses) > 0 && !slices.Contains(query.Statuses, job.Status) {
			continue
		}
		if text != "" && !jobMentions(job, text) {
			continue
		}
		matching = append(matching, job)
	}
	slices.SortStableFunc(matching, func(left, right domain.Job) int {
		if byScore := cmp.Compare(scoreRank(right.Score), scoreRank(left.Score)); byScore != 0 {
			return byScore
		}
		return right.UpdatedAt.Compare(left.UpdatedAt)
	})
	return matching, nil
}

// scoreRank sorts unscored jobs below a score of 0.
func scoreRank(score *int) int {
	if score == nil {
		return -1
	}
	return *score
}

func jobMentions(job domain.Job, lowered string) bool {
	for _, text := range []string{job.Company, job.Title, job.Location, job.Description, job.Notes, job.CompanyNotes, job.RoleNotes, job.NextAction} {
		if strings.Contains(strings.ToLower(text), lowered) {
			return true
		}
	}
	return false
}

// JobDetail is a job with its company page, activity, files and emails.
type JobDetail struct {
	Job     domain.Job
	Company *domain.Company
	Events  []domain.Event
	Files   []files.File
	Emails  []domain.Email
}

// GetJob returns one job and what hangs off it, or storeerr.ErrNotFound.
func (s *Service) GetJob(ctx context.Context, id string) (JobDetail, error) {
	var detail JobDetail
	err := s.store.View(ctx, func(tx store.Tx) error {
		job, err := tx.Jobs().Get(ctx, id)
		if err != nil {
			return err
		}
		detail.Job = job
		company, err := tx.Companies().Get(ctx, job.CompanySlug)
		switch {
		case err == nil:
			detail.Company = &company
		case !errors.Is(err, storeerr.ErrNotFound):
			return err
		}
		if detail.Events, err = tx.Events().List(ctx, events.Filter{JobID: id}); err != nil {
			return err
		}
		if detail.Files, err = tx.Files().ListByJob(ctx, id); err != nil {
			return err
		}
		detail.Emails, err = tx.Emails().List(ctx, emails.Filter{JobID: id})
		return err
	})
	if err != nil {
		return JobDetail{}, fmt.Errorf("get job %s: %w", id, err)
	}
	return detail, nil
}

// JobWrite is one create, patch or upsert: the patch and an optional note for the activity log.
type JobWrite struct {
	Patch domain.JobPatch
	Note  string
}

// CreateJob adds a job. id may be empty (the slug of company and title); storeerr.ErrExists when taken.
func (s *Service) CreateJob(ctx context.Context, actor Actor, id string, write JobWrite) (domain.Job, error) {
	if id == "" {
		derived, ok := domain.JobIDFor(write.Patch.Company.Value(), write.Patch.Title.Value())
		if !ok {
			return domain.Job{}, &domain.ValidationError{Field: "id", Problem: "can't be made from company and title; send one"}
		}
		id = derived
	}
	var created domain.Job
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		var err error
		created, err = s.createJobIn(ctx, tx, actor, id, write)
		return err
	})
	if err != nil {
		return domain.Job{}, fmt.Errorf("create job: %w", err)
	}
	return created, nil
}

func (s *Service) createJobIn(ctx context.Context, tx store.Tx, actor Actor, id string, write JobWrite) (domain.Job, error) {
	now := s.now()
	job, err := domain.NewJob(id, write.Patch, actor.Writer, now)
	if err != nil {
		return domain.Job{}, err
	}
	if err := tx.Jobs().Create(ctx, job); err != nil {
		return domain.Job{}, err
	}
	if err := ensureCompanyPage(ctx, tx, job); err != nil {
		return domain.Job{}, err
	}
	if _, err := logEvent(ctx, tx, job.ID, actor.Name, "Added job", job.Company+": "+job.Title, now); err != nil {
		return domain.Job{}, err
	}
	if err := logNote(ctx, tx, job.ID, actor, write.Note, now); err != nil {
		return domain.Job{}, err
	}
	return job, nil
}

// ensureCompanyPage starts the company page a job links to, when there isn't one yet.
func ensureCompanyPage(ctx context.Context, tx store.Tx, job domain.Job) error {
	if job.CompanySlug == "" {
		return nil
	}
	_, err := tx.Companies().Get(ctx, job.CompanySlug)
	if !errors.Is(err, storeerr.ErrNotFound) {
		return err
	}
	company := domain.Company{Slug: job.CompanySlug, Name: strings.TrimSpace(job.Company), UpdatedAt: job.UpdatedAt}
	return tx.Companies().Create(ctx, company)
}

// logNote logs a write's `note` as its own activity line.
func logNote(ctx context.Context, tx store.Tx, jobID string, actor Actor, note string, at time.Time) error {
	if strings.TrimSpace(note) == "" {
		return nil
	}
	_, err := logEvent(ctx, tx, jobID, actor.Name, note, "", at)
	return err
}

// PatchJob changes the named fields of a job; storeerr.ErrNotFound when it is gone.
func (s *Service) PatchJob(ctx context.Context, actor Actor, id string, write JobWrite) (domain.Job, error) {
	var patched domain.Job
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Jobs().Get(ctx, id)
		if err != nil {
			return err
		}
		patched, err = s.patchJobIn(ctx, tx, actor, current, write)
		return err
	})
	if err != nil {
		return domain.Job{}, fmt.Errorf("patch job %s: %w", id, err)
	}
	return patched, nil
}

func (s *Service) patchJobIn(ctx context.Context, tx store.Tx, actor Actor, current domain.Job, write JobWrite) (domain.Job, error) {
	now := s.now()
	result, err := domain.ApplyJobPatch(current, write.Patch, actor.Writer, now)
	if err != nil {
		return domain.Job{}, err
	}
	job := result.Record
	if len(result.Changed) > 0 {
		if err := tx.Jobs().Update(ctx, job); err != nil {
			return domain.Job{}, err
		}
		if err := ensureCompanyPage(ctx, tx, job); err != nil {
			return domain.Job{}, err
		}
		if result.StatusChange.Changed {
			if _, err := logEvent(ctx, tx, job.ID, actor.Name, "Status changed", domain.StatusChangeDetail(result.StatusChange), now); err != nil {
				return domain.Job{}, err
			}
		}
		detail := changeDetail(actor.Writer, result.Changed, wire.JobObject(result.Before))
		if _, err := logEvent(ctx, tx, job.ID, actor.Name, "Updated", detail, now); err != nil {
			return domain.Job{}, err
		}
	}
	if err := logNote(ctx, tx, job.ID, actor, write.Note, now); err != nil {
		return domain.Job{}, err
	}
	return job, nil
}

// UpsertJob creates the job at id, or patches it when it exists. created says which.
func (s *Service) UpsertJob(ctx context.Context, actor Actor, id string, write JobWrite) (domain.Job, bool, error) {
	var job domain.Job
	created := false
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Jobs().Get(ctx, id)
		if errors.Is(err, storeerr.ErrNotFound) {
			created = true
			job, err = s.createJobIn(ctx, tx, actor, id, write)
			return err
		}
		if err != nil {
			return err
		}
		job, err = s.patchJobIn(ctx, tx, actor, current, write)
		return err
	})
	if err != nil {
		return domain.Job{}, false, fmt.Errorf("upsert job %s: %w", id, err)
	}
	return job, created, nil
}

// DeleteJob removes a job (its activity stays, as the audit trail). Owner only: the HTTP layer checks.
func (s *Service) DeleteJob(ctx context.Context, actor Actor, id string) error {
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		job, err := tx.Jobs().Get(ctx, id)
		if err != nil {
			return err
		}
		if err := tx.Jobs().Delete(ctx, id); err != nil {
			return err
		}
		_, err = logEvent(ctx, tx, id, actor.Name, "Deleted job", job.Company+": "+job.Title, s.now())
		return err
	})
	if err != nil {
		return fmt.Errorf("delete job %s: %w", id, err)
	}
	return nil
}

// LogEvent writes one activity line, on a job (which must exist) or search-wide (jobID empty).
func (s *Service) LogEvent(ctx context.Context, actor Actor, jobID, action, detail string) (domain.Event, error) {
	var event domain.Event
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		if jobID != "" {
			if _, err := tx.Jobs().Get(ctx, jobID); err != nil {
				return err
			}
		}
		var err error
		event, err = logEvent(ctx, tx, jobID, actor.Name, action, detail, s.now())
		return err
	})
	if err != nil {
		return domain.Event{}, fmt.Errorf("log event: %w", err)
	}
	return event, nil
}

// SaveContact saves one contact on a job (same name, ignoring case, is replaced where it stands).
func (s *Service) SaveContact(ctx context.Context, actor Actor, jobID string, contact domain.Contact) (domain.Job, error) {
	var job domain.Job
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Jobs().Get(ctx, jobID)
		if err != nil {
			return err
		}
		contacts, err := domain.UpsertContact(current.Contacts, contact)
		if err != nil {
			return err
		}
		job, err = s.patchJobIn(ctx, tx, actor, current, JobWrite{Patch: domain.JobPatch{Contacts: domain.Set(contacts)}})
		return err
	})
	if err != nil {
		return domain.Job{}, fmt.Errorf("save contact on %s: %w", jobID, err)
	}
	return job, nil
}

// EventLine is an activity line with its job's company and title (search-wide list).
type EventLine struct {
	Event   domain.Event
	Company string
	Title   string
}

// ListEvents returns the newest activity across every job.
func (s *Service) ListEvents(ctx context.Context, limit int) ([]EventLine, error) {
	var lines []EventLine
	err := s.store.View(ctx, func(tx store.Tx) error {
		list, err := tx.Events().List(ctx, events.Filter{Limit: limit})
		if err != nil {
			return err
		}
		titles := map[string]domain.Job{}
		for _, event := range list {
			line := EventLine{Event: event}
			if event.JobID != "" {
				job, seen := titles[event.JobID]
				if !seen {
					job, err = tx.Jobs().Get(ctx, event.JobID)
					if err != nil && !errors.Is(err, storeerr.ErrNotFound) {
						return err
					}
					titles[event.JobID] = job
				}
				line.Company, line.Title = job.Company, job.Title
			}
			lines = append(lines, line)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return lines, nil
}
