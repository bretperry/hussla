// Tests for the move from the prototype: its GET /api/export file (and its GET /api/emails list) into a fresh Hussla.
// In the app: Settings → "Import from the old tracker" and `hussla import`.
// Uses: docs/reference/prototype/export-sample.json, a synthetic file in the prototype export's shape (never the owner's data).

package importseed_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/app/importseed"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

func exportSample(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "reference", "prototype", "export-sample.json"))
	if err != nil {
		t.Fatalf("read the sample export: %v", err)
	}
	return raw
}

func importOrFail(t *testing.T, target store.Store, raw []byte) importseed.Report {
	t.Helper()
	report, err := importseed.Import(t.Context(), target, bytes.NewReader(raw), now)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	return report
}

func hasLine(lines []string, part string) bool {
	return slices.ContainsFunc(lines, func(line string) bool { return strings.Contains(line, part) })
}

func TestPrototypeExportImportsOnceAndTwiceIsTheSameRows(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			first := importOrFail(t, target, exportSample(t))
			wantCreated := map[string]int{"companies": 2, "jobs": 4, "answers": 2, "events": 4, "emails": 5}
			gotCreated := map[string]int{"companies": first.Companies.Created, "jobs": first.Jobs.Created, "answers": first.Answers.Created, "events": first.Events.Created, "emails": first.Emails.Created}
			if !reflect.DeepEqual(gotCreated, wantCreated) {
				t.Fatalf("created = %v, want %v (warnings: %v)", gotCreated, wantCreated, first.Warnings)
			}
			if !first.ConfigStored || first.NeedApproval != 3 || first.FilesNotImported != 1 {
				t.Errorf("config stored %v, need approval %d, files not imported %d; want true, 3, 1", first.ConfigStored, first.NeedApproval, first.FilesNotImported)
			}
			if !slices.Contains(first.Notices, importseed.NoticeSecrets) || !hasLine(first.Notices, "never sent") || !hasLine(first.Notices, "attached file") {
				t.Errorf("notices must name secrets, unsent emails and files: %v", first.Notices)
			}
			if !hasLine(first.Warnings, `status "ghosted" has no match`) {
				t.Errorf("an unmapped status must be reported: %v", first.Warnings)
			}
			if hasLine(first.Warnings, "unknown section") {
				t.Errorf("every section of a prototype export is known: %v", first.Warnings)
			}
			snapshotOnce := takeSnapshot(t, target)

			second := importOrFail(t, target, exportSample(t))
			if created := second.Companies.Created + second.Jobs.Created + second.Answers.Created + second.Events.Created + second.Emails.Created; created != 0 || second.ConfigStored {
				t.Errorf("a second import created %d records (config stored %v)", created, second.ConfigStored)
			}
			if snapshotTwice := takeSnapshot(t, target); !reflect.DeepEqual(snapshotOnce, snapshotTwice) {
				t.Errorf("importing the export twice changed the store")
			}
		})
	}
}

// The values in the file come through: statuses, fixed-width UTC times, nested company data, answers.
func TestPrototypeExportRoundTripsItsValues(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			importOrFail(t, target, exportSample(t))
			var file struct {
				Jobs []map[string]any `json:"jobs"`
			}
			if err := json.Unmarshal(exportSample(t), &file); err != nil {
				t.Fatal(err)
			}
			snap := takeSnapshot(t, target)
			jobsByID := map[string]domain.Job{}
			for _, job := range snap.Jobs {
				jobsByID[job.ID] = job
			}
			for _, want := range file.Jobs {
				id, _ := want["id"].(string)
				job, ok := jobsByID[id]
				if !ok {
					t.Errorf("job %s missing", id)
					continue
				}
				if status, _ := want["status"].(string); status != "ghosted" && job.Status.String() != status {
					t.Errorf("job %s status = %s, want %s", id, job.Status, status)
				}
				for field, got := range map[string]string{"createdAt": domain.FormatTimestamp(job.CreatedAt), "updatedAt": domain.FormatTimestamp(job.UpdatedAt)} {
					if want[field] != got {
						t.Errorf("job %s %s = %s, want %v", id, field, got, want[field])
					}
				}
			}
			staff := jobsByID["example-co-staff-engineer"]
			if domain.FormatTimestamp(staff.AppliedAt) != "2026-09-22T18:05:00.000Z" || len(staff.Contacts) != 1 || staff.Followup.EmailSentAt.IsZero() {
				t.Errorf("the applied job lost its applied date, contact or follow-up: %+v", staff)
			}
			if ghosted := jobsByID["sample-labs-design-engineer"]; ghosted.Status != domain.JobStatusReview {
				t.Errorf("an unmapped status lands as review, got %s", ghosted.Status)
			}
			if len(snap.Companies) != 2 || len(snap.Companies[0].Reviews) != 1 {
				t.Errorf("companies or their reviews were lost: %+v", snap.Companies)
			}
			unanswered := 0
			for _, answer := range snap.Answers {
				if answer.IsUnanswered() {
					unanswered++
				}
			}
			if len(snap.Answers) != 2 || unanswered != 1 {
				t.Errorf("answers = %d (%d unanswered), want 2 (1)", len(snap.Answers), unanswered)
			}
			if _, ok := snap.Config[settings.KeySearchConfig]; !ok {
				t.Errorf("the search settings weren't stored")
			}
		})
	}
}

// No imported email can go out on its own: sent ones are history, the rest wait for a new approval.
func TestPrototypeEmailsNeverSendByThemselves(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			importOrFail(t, target, exportSample(t))
			byID := map[string]domain.Email{}
			for _, email := range takeSnapshot(t, target).Emails {
				byID[email.ID] = email
			}
			suffix := "00000000-0000-4000-8000-0000000000"
			sent := byID[suffix+"e1"]
			if sent.Status != domain.EmailStatusSent || domain.FormatTimestamp(sent.SentAt) != "2026-09-29T17:00:00.000Z" || sent.MessageID == "" {
				t.Errorf("a sent email must stay sent history: %+v", sent)
			}
			for _, id := range []string{"e2", "e3"} {
				if email := byID[suffix+id]; email.Status != domain.EmailStatusDraft || email.ApprovedBy != "" || !email.ApprovedAt.IsZero() {
					t.Errorf("email %s must land as an unapproved draft: %+v", id, email)
				}
			}
			if uncertain := byID[suffix+"e4"]; uncertain.Status != domain.EmailStatusFailed || uncertain.Error != domain.UncertainSendError {
				t.Errorf("an email caught mid-send must land failed and uncertain: %+v", uncertain)
			}
			if canceled := byID[suffix+"e5"]; canceled.Status != domain.EmailStatusCanceled {
				t.Errorf("a canceled email stays canceled: %+v", canceled)
			}
			if linked := byID[suffix+"e2"]; linked.JobID != "sample-labs-product-engineer" || linked.CompanySlug != "sample-labs" {
				t.Errorf("an email keeps its job and company: %+v", linked)
			}
			err := target.View(t.Context(), func(tx store.Tx) error {
				_, err := tx.Emails().NextApproved(t.Context())
				return err
			})
			if !errors.Is(err, storeerr.ErrNotFound) {
				t.Errorf("the send queue must be empty after an import, got %v", err)
			}
		})
	}
}

// Existing Hussla data wins: a job, company or search setting already here is never overwritten.
func TestPrototypeImportNeverOverwritesExistingData(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			edited, err := domain.NewJob("example-co-staff-engineer", domain.JobPatch{
				Company: domain.Set("Example Co"), Title: domain.Set("Edited in Hussla"), Status: domain.Set(domain.JobStatusOffer),
			}, domain.WriterOwner, now)
			if err != nil {
				t.Fatal(err)
			}
			if err := target.Atomically(t.Context(), func(tx store.Tx) error {
				if err := tx.Jobs().Create(t.Context(), edited); err != nil {
					return err
				}
				return tx.Settings().Set(t.Context(), settings.KeySearchConfig, `{"paused":true}`)
			}); err != nil {
				t.Fatal(err)
			}
			report := importOrFail(t, target, exportSample(t))
			if report.Jobs.Created != 3 || report.Jobs.Skipped != 1 || report.ConfigStored {
				t.Errorf("jobs created %d skipped %d, config stored %v; want 3, 1, false", report.Jobs.Created, report.Jobs.Skipped, report.ConfigStored)
			}
			if !hasLine(report.Warnings, "already set here") {
				t.Errorf("kept search settings must be reported: %v", report.Warnings)
			}
			snap := takeSnapshot(t, target)
			for _, job := range snap.Jobs {
				if job.ID == edited.ID && (job.Title != "Edited in Hussla" || job.Status != domain.JobStatusOffer) {
					t.Errorf("the existing job was overwritten: %+v", job)
				}
			}
			if snap.Config[settings.KeySearchConfig] != `{"paused":true}` {
				t.Errorf("the existing search settings were overwritten: %s", snap.Config[settings.KeySearchConfig])
			}
		})
	}
}

// The prototype's GET /api/emails (a bare list) imports on its own, and adds nothing after the export brought the same emails.
func TestPrototypeEmailListImports(t *testing.T) {
	var file struct {
		Emails json.RawMessage `json:"emails"`
	}
	if err := json.Unmarshal(exportSample(t), &file); err != nil {
		t.Fatal(err)
	}
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			alone := importOrFail(t, target, file.Emails)
			if alone.Emails.Created != 5 || !hasLine(alone.Warnings, "isn't here; imported without a job") {
				t.Errorf("a list on an empty install: created %d, warnings %v", alone.Emails.Created, alone.Warnings)
			}
			again := importOrFail(t, target, file.Emails)
			if again.Emails.Created != 0 || again.Emails.Skipped != 5 {
				t.Errorf("the same list twice must add nothing: %+v", again.Emails)
			}
		})
	}
}
