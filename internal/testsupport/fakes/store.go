// An in-memory store.Store: the same contract as the SQLite adapter, for use-case tests that don't need a disk.
// In the app: nothing at runtime (tests only).
// Used by: use-case tests in internal/app and internal/httpapi (Phases 3-4); the shared contract suite runs it beside SQLite.
// Uses: the repository ports in internal/app; deepCopy (clone.go).
//
// Atomically works on a copy and publishes it only when the work succeeds, so a failed unit of
// work leaves nothing behind, exactly like a rolled-back transaction. One unit runs at a time.

package fakes

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bretperry/hussla/internal/app/answers"
	"github.com/bretperry/hussla/internal/app/companies"
	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/pitches"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tokens"
	"github.com/bretperry/hussla/internal/domain"
)

// ErrReadOnly is what a write through a View's Tx returns.
var ErrReadOnly = errors.New("fakes: write inside a read-only view")

// data is everything the fake holds.
type data struct {
	Jobs      map[string]domain.Job
	Companies map[string]domain.Company
	Events    []domain.Event
	EventKeys map[string]bool
	NextEvent int64
	Answers   map[string]domain.Answer
	Files     map[string]files.File
	Tokens    map[string]tokens.Token
	Settings  map[string]string
	Emails    map[string]domain.Email
	Pitches   map[int]domain.Pitch
}

func newData() data {
	return data{
		Jobs: map[string]domain.Job{}, Companies: map[string]domain.Company{}, EventKeys: map[string]bool{},
		Answers: map[string]domain.Answer{}, Files: map[string]files.File{}, Tokens: map[string]tokens.Token{},
		Settings: map[string]string{}, Emails: map[string]domain.Email{}, Pitches: map[int]domain.Pitch{},
	}
}

// Store is the in-memory store.Store.
type Store struct {
	mutex sync.Mutex
	state data
}

var _ store.Store = (*Store)(nil)

// New returns an empty store.
func New() *Store { return &Store{state: newData()} }

// Atomically runs work on a copy and keeps it only if work returns nil.
func (s *Store) Atomically(_ context.Context, work func(store.Tx) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	working := &unit{state: deepCopy(s.state)}
	if err := work(working); err != nil {
		return err
	}
	s.state = working.state
	return nil
}

// View runs work on a copy that is thrown away; writes fail with ErrReadOnly.
func (s *Store) View(_ context.Context, work func(store.Tx) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return work(&unit{state: deepCopy(s.state), readOnly: true})
}

type unit struct {
	state    data
	readOnly bool
}

func (u *unit) Jobs() jobs.Repository           { return jobRepository{u} }
func (u *unit) Companies() companies.Repository { return companyRepository{u} }
func (u *unit) Events() events.Repository       { return eventRepository{u} }
func (u *unit) Answers() answers.Repository     { return answerRepository{u} }
func (u *unit) Files() files.Repository         { return fileRepository{u} }
func (u *unit) Tokens() tokens.Repository       { return tokenRepository{u} }
func (u *unit) Settings() settings.Repository   { return settingRepository{u} }
func (u *unit) Emails() emails.Repository       { return emailRepository{u} }
func (u *unit) Pitches() pitches.Repository     { return pitchRepository{u} }

// writable is nil in a Atomically unit and ErrReadOnly in a View.
func (u *unit) writable() error {
	if u.readOnly {
		return ErrReadOnly
	}
	return nil
}

// ---- jobs

type jobRepository struct{ u *unit }

func (r jobRepository) Get(_ context.Context, id string) (domain.Job, error) {
	job, found := r.u.state.Jobs[id]
	if !found {
		return domain.Job{}, storeerr.ErrNotFound
	}
	return deepCopy(job), nil
}

func (r jobRepository) List(_ context.Context, filter jobs.Filter) ([]domain.Job, error) {
	var found []domain.Job
	for _, job := range r.u.state.Jobs {
		if filter.Status != nil && job.Status != *filter.Status {
			continue
		}
		if filter.CompanySlug != "" && job.CompanySlug != filter.CompanySlug {
			continue
		}
		found = append(found, deepCopy(job))
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.After(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return limited(found, filter.Limit), nil
}

func (r jobRepository) Create(_ context.Context, job domain.Job) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Jobs[job.ID]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Jobs[job.ID] = deepCopy(job)
	return nil
}

func (r jobRepository) Update(_ context.Context, job domain.Job) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Jobs[job.ID]; !found {
		return storeerr.ErrNotFound
	}
	r.u.state.Jobs[job.ID] = deepCopy(job)
	return nil
}

func (r jobRepository) Delete(_ context.Context, id string) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Jobs[id]; !found {
		return storeerr.ErrNotFound
	}
	delete(r.u.state.Jobs, id)
	return nil
}

// limited cuts a list to limit items; 0 means no limit.
func limited[T any](list []T, limit int) []T {
	if limit > 0 && len(list) > limit {
		return list[:limit]
	}
	return list
}

// ---- companies

type companyRepository struct{ u *unit }

func (r companyRepository) Get(_ context.Context, slug string) (domain.Company, error) {
	company, found := r.u.state.Companies[slug]
	if !found {
		return domain.Company{}, storeerr.ErrNotFound
	}
	return deepCopy(company), nil
}

func (r companyRepository) List(_ context.Context) ([]domain.Company, error) {
	var found []domain.Company
	for _, company := range r.u.state.Companies {
		found = append(found, deepCopy(company))
	}
	sort.Slice(found, func(i, j int) bool {
		left, right := strings.ToLower(found[i].Name), strings.ToLower(found[j].Name)
		if left != right {
			return left < right
		}
		return found[i].Slug < found[j].Slug
	})
	return found, nil
}

func (r companyRepository) Create(_ context.Context, company domain.Company) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Companies[company.Slug]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Companies[company.Slug] = deepCopy(company)
	return nil
}

func (r companyRepository) Update(_ context.Context, company domain.Company) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Companies[company.Slug]; !found {
		return storeerr.ErrNotFound
	}
	r.u.state.Companies[company.Slug] = deepCopy(company)
	return nil
}

// ---- events

type eventRepository struct{ u *unit }

func (r eventRepository) Append(_ context.Context, event domain.Event) (domain.Event, error) {
	if err := r.u.writable(); err != nil {
		return domain.Event{}, err
	}
	r.u.state.NextEvent++
	event.ID = r.u.state.NextEvent
	r.u.state.Events = append(r.u.state.Events, event)
	return event, nil
}

func (r eventRepository) AppendOnce(ctx context.Context, key string, event domain.Event) (bool, error) {
	if err := r.u.writable(); err != nil {
		return false, err
	}
	if r.u.state.EventKeys[key] {
		return false, nil
	}
	r.u.state.EventKeys[key] = true
	_, err := r.Append(ctx, event)
	return err == nil, err
}

func (r eventRepository) List(_ context.Context, filter events.Filter) ([]domain.Event, error) {
	var found []domain.Event
	for _, event := range r.u.state.Events {
		switch {
		case filter.JobID != "" && event.JobID != filter.JobID:
		case filter.Actor != "" && event.Actor != filter.Actor:
		case !filter.Since.IsZero() && event.At.Before(filter.Since):
		default:
			found = append(found, event)
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].At.Equal(found[j].At) {
			return found[i].At.After(found[j].At)
		}
		return found[i].ID > found[j].ID
	})
	limit := filter.Limit
	if limit <= 0 {
		limit = events.DefaultLimit
	}
	return limited(found, limit), nil
}

// ---- answers

type answerRepository struct{ u *unit }

func (r answerRepository) Get(_ context.Context, id string) (domain.Answer, error) {
	answer, found := r.u.state.Answers[id]
	if !found {
		return domain.Answer{}, storeerr.ErrNotFound
	}
	return deepCopy(answer), nil
}

func (r answerRepository) List(_ context.Context) ([]domain.Answer, error) {
	var found []domain.Answer
	for _, answer := range r.u.state.Answers {
		found = append(found, deepCopy(answer))
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.Before(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return found, nil
}

func (r answerRepository) Create(_ context.Context, answer domain.Answer) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Answers[answer.ID]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Answers[answer.ID] = deepCopy(answer)
	return nil
}

func (r answerRepository) Update(_ context.Context, answer domain.Answer) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Answers[answer.ID]; !found {
		return storeerr.ErrNotFound
	}
	r.u.state.Answers[answer.ID] = deepCopy(answer)
	return nil
}

func (r answerRepository) Delete(_ context.Context, id string) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Answers[id]; !found {
		return storeerr.ErrNotFound
	}
	delete(r.u.state.Answers, id)
	return nil
}

// ---- pitches

type pitchRepository struct{ u *unit }

func (r pitchRepository) Get(_ context.Context, slot int) (domain.Pitch, error) {
	pitch, found := r.u.state.Pitches[slot]
	if !found {
		return domain.Pitch{}, storeerr.ErrNotFound
	}
	return deepCopy(pitch), nil
}

func (r pitchRepository) List(_ context.Context) ([]domain.Pitch, error) {
	var found []domain.Pitch
	for _, pitch := range r.u.state.Pitches {
		found = append(found, deepCopy(pitch))
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Slot < found[j].Slot })
	return found, nil
}

func (r pitchRepository) Create(_ context.Context, pitch domain.Pitch) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Pitches[pitch.Slot]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Pitches[pitch.Slot] = deepCopy(pitch)
	return nil
}

func (r pitchRepository) Update(_ context.Context, pitch domain.Pitch) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Pitches[pitch.Slot]; !found {
		return storeerr.ErrNotFound
	}
	r.u.state.Pitches[pitch.Slot] = deepCopy(pitch)
	return nil
}

func (r pitchRepository) Delete(_ context.Context, slot int) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Pitches[slot]; !found {
		return storeerr.ErrNotFound
	}
	delete(r.u.state.Pitches, slot)
	return nil
}

// ---- files

type fileRepository struct{ u *unit }

func (r fileRepository) Get(_ context.Context, id string) (files.File, error) {
	file, found := r.u.state.Files[id]
	if !found {
		return files.File{}, storeerr.ErrNotFound
	}
	return file, nil
}

func (r fileRepository) ListByJob(_ context.Context, jobID string) ([]files.File, error) {
	var found []files.File
	for _, file := range r.u.state.Files {
		if file.JobID == jobID {
			found = append(found, file)
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.Before(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return found, nil
}

func (r fileRepository) Create(_ context.Context, file files.File) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Files[file.ID]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Files[file.ID] = file
	return nil
}

func (r fileRepository) Delete(_ context.Context, id string) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, found := r.u.state.Files[id]; !found {
		return storeerr.ErrNotFound
	}
	delete(r.u.state.Files, id)
	return nil
}

// ---- tokens

type tokenRepository struct{ u *unit }

func (r tokenRepository) Create(_ context.Context, token tokens.Token) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	for _, existing := range r.u.state.Tokens {
		if existing.ID == token.ID || existing.Hash == token.Hash {
			return storeerr.ErrExists
		}
	}
	r.u.state.Tokens[token.ID] = token
	return nil
}

func (r tokenRepository) GetByHash(_ context.Context, hash string) (tokens.Token, error) {
	for _, token := range r.u.state.Tokens {
		if token.Hash == hash {
			return token, nil
		}
	}
	return tokens.Token{}, storeerr.ErrNotFound
}

func (r tokenRepository) List(_ context.Context) ([]tokens.Token, error) {
	var found []tokens.Token
	for _, token := range r.u.state.Tokens {
		found = append(found, token)
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.Before(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return found, nil
}

func (r tokenRepository) Revoke(_ context.Context, id string, at time.Time) (bool, error) {
	if err := r.u.writable(); err != nil {
		return false, err
	}
	token, found := r.u.state.Tokens[id]
	if !found {
		return false, storeerr.ErrNotFound
	}
	if token.IsRevoked() {
		return false, nil
	}
	token.RevokedAt = at
	r.u.state.Tokens[id] = token
	return true, nil
}

func (r tokenRepository) Touch(_ context.Context, id string, at time.Time) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	token, found := r.u.state.Tokens[id]
	if !found {
		return storeerr.ErrNotFound
	}
	if token.LastUsedAt.IsZero() || token.LastUsedAt.Before(at) {
		token.LastUsedAt = at
		r.u.state.Tokens[id] = token
	}
	return nil
}

// ---- settings

type settingRepository struct{ u *unit }

func (r settingRepository) Get(_ context.Context, key string) (string, error) {
	value, found := r.u.state.Settings[key]
	if !found {
		return "", storeerr.ErrNotFound
	}
	return value, nil
}

func (r settingRepository) Set(_ context.Context, key, value string) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	r.u.state.Settings[key] = value
	return nil
}

func (r settingRepository) All(_ context.Context) (map[string]string, error) {
	all := make(map[string]string, len(r.u.state.Settings))
	for key, value := range r.u.state.Settings {
		all[key] = value
	}
	return all, nil
}

// ---- emails

type emailRepository struct{ u *unit }

func (r emailRepository) Get(_ context.Context, id string) (domain.Email, error) {
	email, found := r.u.state.Emails[id]
	if !found {
		return domain.Email{}, storeerr.ErrNotFound
	}
	return deepCopy(email), nil
}

func (r emailRepository) List(_ context.Context, filter emails.Filter) ([]domain.Email, error) {
	var found []domain.Email
	for _, email := range r.u.state.Emails {
		switch {
		case filter.Status != nil && email.Status != *filter.Status:
		case filter.JobID != "" && email.JobID != filter.JobID:
		case filter.CompanySlug != "" && email.CompanySlug != filter.CompanySlug:
		default:
			found = append(found, deepCopy(email))
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.After(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return limited(found, filter.Limit), nil
}

func (r emailRepository) Create(_ context.Context, email domain.Email) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	if _, taken := r.u.state.Emails[email.ID]; taken {
		return storeerr.ErrExists
	}
	r.u.state.Emails[email.ID] = deepCopy(email)
	return nil
}

func (r emailRepository) Replace(_ context.Context, was, next domain.Email) error {
	if err := r.u.writable(); err != nil {
		return err
	}
	stored, found := r.u.state.Emails[was.ID]
	if !found {
		return storeerr.ErrNotFound
	}
	if stored.Status != was.Status || stored.Version != was.Version || stored.Attempts != was.Attempts {
		return storeerr.ErrConflict
	}
	r.u.state.Emails[was.ID] = deepCopy(next)
	return nil
}

func (r emailRepository) NextApproved(_ context.Context) (domain.Email, error) {
	var oldest *domain.Email
	for _, email := range r.u.state.Emails {
		if email.Status != domain.EmailStatusApproved {
			continue
		}
		if oldest == nil || email.ApprovedAt.Before(oldest.ApprovedAt) ||
			(email.ApprovedAt.Equal(oldest.ApprovedAt) && email.ID < oldest.ID) {
			candidate := email
			oldest = &candidate
		}
	}
	if oldest == nil {
		return domain.Email{}, storeerr.ErrNotFound
	}
	return deepCopy(*oldest), nil
}

func (r emailRepository) ListSending(_ context.Context) ([]domain.Email, error) {
	var found []domain.Email
	for _, email := range r.u.state.Emails {
		if email.Status == domain.EmailStatusSending {
			found = append(found, deepCopy(email))
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].CreatedAt.Equal(found[j].CreatedAt) {
			return found[i].CreatedAt.Before(found[j].CreatedAt)
		}
		return found[i].ID < found[j].ID
	})
	return found, nil
}

func (r emailRepository) SentHistory(_ context.Context, since time.Time) (emails.SendHistory, error) {
	var history emails.SendHistory
	for _, email := range r.u.state.Emails {
		if email.Status != domain.EmailStatusSent || email.SentAt.IsZero() {
			continue
		}
		if email.SentAt.After(history.LastSentAt) {
			history.LastSentAt = email.SentAt
		}
		if !email.SentAt.Before(since) {
			history.SentSince++
		}
	}
	return history, nil
}
