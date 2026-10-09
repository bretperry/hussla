// Seed import: loads the prototype's seed bundle (config, companies, jobs, answers, events, pitches) into the store.
// In the app: the setup wizard's "import a seed file" step and the one-time move from the prototype.
// Used by: the setup use-case and `hussla import` (Phases 3 and 6).
// Uses: internal/app/store (one unit of work), internal/app/wire (the bundle's JSON), internal/domain (the rules a new record must pass).
//
// Idempotent by "existing wins": a record whose id (slug, answer id, event identity) is already
// stored is left exactly as it is, so importing the same file twice adds nothing, and importing
// it after the owner edited a job never overwrites the edit. The whole file lands in one unit of
// work, so a failure part-way leaves nothing behind. A record that breaks a rule (a job with no
// title) is skipped and named in Report.Warnings rather than stopping the rest.
//
// Imported fields carry no writer: the domain counts a field with no recorded writer as
// agent-written, so the owner's later edits are the first ones it protects.
//
// The real seed is the owner's private file, picked at install time; the repo only ever holds a
// synthetic sample (docs/reference/prototype/seed-sample.json).

package importseed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/companies"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// MaxBundleBytes caps the file read; a real search is well under a megabyte.
const MaxBundleBytes = 32 << 20

// Count is what happened to one kind of record.
type Count struct {
	Created int
	Skipped int // already stored (left as is) or broke a rule (see Warnings)
}

// Report says what an import did.
type Report struct {
	Companies, Jobs, Answers, Events Count
	Pitches                          Count
	// ConfigStored is true when the search configuration was written; false when one was already stored or the file had none.
	ConfigStored bool
	Warnings     []string
}

// bundle is the file's top level. Sections stay raw until a record is read.
type bundle struct {
	Config    json.RawMessage   `json:"config"`
	Companies []json.RawMessage `json:"companies"`
	Jobs      []json.RawMessage `json:"jobs"`
	Answers   []json.RawMessage `json:"answers"`
	Events    []json.RawMessage `json:"events"`
	Pitches   []json.RawMessage `json:"pitches"`
}

// knownSections are the keys a bundle may have; others are reported, not stored.
var knownSections = map[string]bool{"config": true, "companies": true, "jobs": true, "answers": true, "events": true, "pitches": true}

// Import reads a bundle from input and stores what is new, in one unit of work. `now` stamps
// records the file gave no time for.
func Import(ctx context.Context, target store.Store, input io.Reader, now time.Time) (Report, error) {
	raw, err := io.ReadAll(io.LimitReader(input, MaxBundleBytes+1))
	if err != nil {
		return Report{}, fmt.Errorf("read seed file: %w", err)
	}
	if len(raw) > MaxBundleBytes {
		return Report{}, fmt.Errorf("the seed file is larger than %d MB", MaxBundleBytes>>20)
	}
	var parsed bundle
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Report{}, fmt.Errorf("the seed file isn't valid JSON of the expected shape: %w", err)
	}
	var sections map[string]json.RawMessage
	if err := json.Unmarshal(raw, &sections); err != nil {
		return Report{}, fmt.Errorf("the seed file isn't a JSON object: %w", err)
	}
	now = domain.NormalizeTime(now)
	importer := &importer{now: now}
	for name := range sections {
		if !knownSections[name] {
			importer.warn("seed file", "unknown section %q ignored", name)
		}
	}
	err = target.Atomically(ctx, func(tx store.Tx) error {
		importer.report = Report{Warnings: importer.report.Warnings} // a retried unit of work starts its counts again
		return importer.run(ctx, tx, parsed, raw)
	})
	if err != nil {
		return Report{}, err //nolint:wrapcheck // run's errors are wrapped where they arise; the store's own failure passes through
	}
	return importer.report, nil
}

type importer struct {
	now    time.Time
	report Report
}

func (i *importer) warn(where, format string, args ...any) {
	i.report.Warnings = append(i.report.Warnings, where+": "+fmt.Sprintf(format, args...))
}

func (i *importer) run(ctx context.Context, tx store.Tx, parsed bundle, raw []byte) error {
	if err := i.importConfig(ctx, tx, parsed.Config); err != nil {
		return err
	}
	for index, record := range parsed.Companies {
		if err := i.importCompany(ctx, tx, index, record); err != nil {
			return err
		}
	}
	for index, record := range parsed.Jobs {
		if err := i.importJob(ctx, tx, index, record); err != nil {
			return err
		}
	}
	for index, record := range parsed.Answers {
		if err := i.importAnswer(ctx, tx, index, record); err != nil {
			return err
		}
	}
	for index, record := range parsed.Events {
		if err := i.importEvent(ctx, tx, index, record); err != nil {
			return err
		}
	}
	for index, record := range parsed.Pitches {
		if err := i.importPitch(ctx, tx, index, record); err != nil {
			return err
		}
	}
	return i.logImport(ctx, tx, raw)
}

func (i *importer) importConfig(ctx context.Context, tx store.Tx, config json.RawMessage) error {
	trimmed := strings.TrimSpace(string(config))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if _, err := wire.ParseObject(config); err != nil {
		i.warn("config", "must be an object; ignored")
		return nil
	}
	_, err := tx.Settings().Get(ctx, settings.KeySearchConfig)
	switch {
	case err == nil:
		return nil // the stored configuration wins
	case !errors.Is(err, storeerr.ErrNotFound):
		return fmt.Errorf("read search config: %w", err)
	}
	if err := tx.Settings().Set(ctx, settings.KeySearchConfig, compact(config)); err != nil {
		return fmt.Errorf("store search config: %w", err)
	}
	i.report.ConfigStored = true
	return nil
}

// compact is the JSON with insignificant space removed (the bytes were validated as an object).
func compact(raw json.RawMessage) string {
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		return string(raw)
	}
	return out.String()
}

func (i *importer) importCompany(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("company #%d", index+1)
	object, err := wire.ParseObject(record)
	if err != nil {
		i.report.Companies.Skipped++
		i.warn(where, "not an object; skipped")
		return nil
	}
	decoder := &wire.Decoder{Lenient: true}
	patch, _ := decoder.DecodeCompanyPatch(object) // lenient: never fails
	seeded, _ := wire.DecodeCompany(object)
	for _, warning := range decoder.Warnings() {
		i.warn(where, "%s", warning)
	}
	if !patch.Name.IsSet() || strings.TrimSpace(patch.Name.Value()) == "" {
		i.report.Companies.Skipped++
		i.warn(where, "has no name; skipped")
		return nil
	}
	name := strings.TrimSpace(patch.Name.Value())
	patch = i.salvageCompanyPatch(where+" ("+name+")", patch)
	slug := seeded.Slug
	if !domain.IsValidRecordID(slug) {
		allocated, existed, err := companies.AllocateSlug(ctx, tx.Companies(), name)
		if err != nil {
			return fmt.Errorf("allocate slug for %s: %w", name, err)
		}
		if existed {
			i.report.Companies.Skipped++
			return nil
		}
		slug = allocated
	}
	if _, err := tx.Companies().Get(ctx, slug); err == nil {
		i.report.Companies.Skipped++
		return nil
	} else if !errors.Is(err, storeerr.ErrNotFound) {
		return fmt.Errorf("look up company %s: %w", slug, err)
	}
	result, err := domain.ApplyCompanyPatch(domain.Company{Slug: slug, Name: name, UpdatedAt: i.now}, patch, domain.WriterAgent, i.now)
	if err != nil {
		i.report.Companies.Skipped++
		i.warn(where+" ("+slug+")", "%v; skipped", err)
		return nil
	}
	company := result.Record
	if !seeded.UpdatedAt.IsZero() {
		company.UpdatedAt = seeded.UpdatedAt
	}
	if err := tx.Companies().Create(ctx, company); err != nil {
		return fmt.Errorf("store company %s: %w", slug, err)
	}
	i.report.Companies.Created++
	return nil
}

func (i *importer) importJob(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("job #%d", index+1)
	object, err := wire.ParseObject(record)
	if err != nil {
		i.report.Jobs.Skipped++
		i.warn(where, "not an object; skipped")
		return nil
	}
	decoder := &wire.Decoder{Lenient: true}
	patch, _ := decoder.DecodeJobPatch(object) // lenient: never fails
	seeded, _ := wire.DecodeJob(object)
	for _, warning := range decoder.Warnings() {
		i.warn(where, "%s", warning)
	}
	id := seeded.ID
	if !domain.IsValidRecordID(id) {
		derived, ok := domain.JobIDFor(seeded.Company, seeded.Title)
		if !ok {
			i.report.Jobs.Skipped++
			i.warn(where, "has no usable id, company or title; skipped")
			return nil
		}
		id = derived
	}
	if _, err := tx.Jobs().Get(ctx, id); err == nil {
		i.report.Jobs.Skipped++
		return nil
	} else if !errors.Is(err, storeerr.ErrNotFound) {
		return fmt.Errorf("look up job %s: %w", id, err)
	}
	patch = i.salvageJobPatch(where+" ("+id+")", patch)
	job, err := domain.NewJob(id, patch, domain.WriterAgent, i.now)
	if err != nil {
		i.report.Jobs.Skipped++
		i.warn(where+" ("+id+")", "%v; skipped", err)
		return nil
	}
	created := firstTime(seeded.CreatedAt, seeded.FoundAt, i.now)
	job.CreatedAt, job.UpdatedAt = created, firstTime(seeded.UpdatedAt, created, i.now)
	if patch.AppliedAt.IsAbsent() {
		job.AppliedAt = time.Time{} // NewJob stamps "now" on an applied job; an import must not invent a date
	}
	if err := tx.Jobs().Create(ctx, job); err != nil {
		return fmt.Errorf("store job %s: %w", id, err)
	}
	i.report.Jobs.Created++
	return nil
}

func (i *importer) importAnswer(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("answer #%d", index+1)
	object, err := wire.ParseObject(record)
	if err != nil {
		i.report.Answers.Skipped++
		i.warn(where, "not an object; skipped")
		return nil
	}
	answer, warnings := wire.DecodeAnswer(object)
	for _, warning := range warnings {
		i.warn(where, "%s", warning)
	}
	answer.Question = strings.TrimSpace(answer.Question)
	if answer.Question == "" {
		i.report.Answers.Skipped++
		i.warn(where, "has no question; skipped")
		return nil
	}
	if !domain.IsValidRecordID(answer.ID) {
		derived, ok := domain.AnswerIDFor(answer.Question)
		if !ok {
			i.report.Answers.Skipped++
			i.warn(where, "has no usable id or question; skipped")
			return nil
		}
		answer.ID = derived
	}
	if _, err := tx.Answers().Get(ctx, answer.ID); err == nil {
		i.report.Answers.Skipped++
		return nil
	} else if !errors.Is(err, storeerr.ErrNotFound) {
		return fmt.Errorf("look up answer %s: %w", answer.ID, err)
	}
	answer.CreatedAt = firstTime(answer.CreatedAt, i.now)
	if answer.IsUnanswered() {
		answer.AnsweredAt = time.Time{}
	} else if answer.AnsweredAt.IsZero() {
		answer.AnsweredAt = answer.CreatedAt
	}
	if err := tx.Answers().Create(ctx, answer); err != nil {
		return fmt.Errorf("store answer %s: %w", answer.ID, err)
	}
	i.report.Answers.Created++
	return nil
}

// eventJSON is one line of the seed's activity log.
type eventJSON struct {
	At     string  `json:"at"`
	Actor  string  `json:"actor"`
	Action string  `json:"action"`
	Detail string  `json:"detail"`
	JobID  *string `json:"jobId"`
}

func (i *importer) importEvent(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("event #%d", index+1)
	var seeded eventJSON
	if err := json.Unmarshal(record, &seeded); err != nil {
		i.report.Events.Skipped++
		i.warn(where, "not an event object; skipped")
		return nil
	}
	at, err := domain.ParseTimestamp(seeded.At)
	if err != nil || at.IsZero() {
		i.report.Events.Skipped++
		i.warn(where, "has no readable time; skipped")
		return nil
	}
	jobID := ""
	if seeded.JobID != nil {
		jobID = *seeded.JobID
	}
	event, err := domain.NewEvent(jobID, seeded.Actor, seeded.Action, seeded.Detail, at)
	if err != nil {
		i.report.Events.Skipped++
		i.warn(where, "%v; skipped", err)
		return nil
	}
	// The event's identity is its content as written in the file, so the same file twice adds nothing.
	// (Two identical lines in one file are one event.)
	inserted, err := tx.Events().AppendOnce(ctx, "seed-event:"+digest(seeded.At, seeded.Actor, seeded.Action, seeded.Detail, jobID), event)
	if err != nil {
		return fmt.Errorf("store event %d: %w", index+1, err)
	}
	if inserted {
		i.report.Events.Created++
	} else {
		i.report.Events.Skipped++
	}
	return nil
}

// logImport leaves one activity line for an import that added something. Its key is the file's
// digest, so importing the same file again (which adds nothing) adds no second line either.
func (i *importer) logImport(ctx context.Context, tx store.Tx, raw []byte) error {
	created := i.report.Companies.Created + i.report.Jobs.Created + i.report.Answers.Created + i.report.Events.Created
	created += i.report.Pitches.Created
	if created == 0 && !i.report.ConfigStored {
		return nil
	}
	detail := fmt.Sprintf("%d companies, %d jobs, %d answers, %d events", i.report.Companies.Created, i.report.Jobs.Created, i.report.Answers.Created, i.report.Events.Created)
	if i.report.Pitches.Created > 0 {
		detail += fmt.Sprintf(", %d pitches", i.report.Pitches.Created)
	}
	event, err := domain.NewEvent("", domain.ActorImport, "Imported a seed file", detail, i.now)
	if err != nil {
		return fmt.Errorf("build import event: %w", err)
	}
	if _, err := tx.Events().AppendOnce(ctx, "seed-file:"+digest(string(raw)), event); err != nil {
		return fmt.Errorf("log import: %w", err)
	}
	return nil
}

// digest is a stable hex identity for a list of strings.
func digest(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(hash, "%d:%s;", len(part), part)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// firstTime is the first set time of the candidates.
func firstTime(candidates ...time.Time) time.Time {
	for _, candidate := range candidates {
		if !candidate.IsZero() {
			return candidate
		}
	}
	return time.Time{}
}
