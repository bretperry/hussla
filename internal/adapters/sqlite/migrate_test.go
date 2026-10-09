package sqlite_test

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// prototypeSchema is the prototype's schema.sql, read from the repo's reference folder.
func prototypeSchema(t *testing.T) string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "reference", "prototype", "schema.sql"))
	if err != nil {
		t.Fatalf("read the prototype schema: %v", err)
	}
	return string(text)
}

// buildPrototypeDB creates a database exactly as the prototype did, filled with synthetic rows.
// withCompanySlug false leaves out the prototype's late emails.companySlug column.
func buildPrototypeDB(t *testing.T, dir string, withCompanySlug bool) {
	t.Helper()
	schema := prototypeSchema(t)
	if !withCompanySlug {
		schema = strings.Replace(schema, "ALTER TABLE emails ADD COLUMN companySlug TEXT;", "", 1)
	}
	raw, err := sql.Open("sqlite", filepath.Join(dir, "hussla.db"))
	if err != nil {
		t.Fatalf("open prototype db: %v", err)
	}
	defer raw.Close() //nolint:errcheck // closing a read-only handle loses nothing
	statements := []string{
		schema,
		`INSERT INTO jobs (id, company, companySlug, title, status, score, url, location, workType, salaryMin, salaryMax, payText, source, resume,
			foundAt, appliedAt, nextAction, nextActionDue, data, createdAt, updatedAt) VALUES
			('acme-staff', 'Acme', 'acme', 'Staff Engineer', 'applied', 80, 'https://example.com/1', 'Springfield', 'hybrid', 150000, 190000, '$150-190k', 'Greenhouse', 'example-resume',
			'2026-09-01T12:00:00.000Z', '2026-09-02T09:30:00.000Z', 'Send thank-you', '2026-09-05',
			'{"description":"A synthetic role.","reasons":["remote","team"],"contacts":[{"name":"Jane Example","email":"jane@example.com","emailStatus":"verified"}],
			"followup":{"to":"jane@example.com","subject":"Hello","body":"Hi Jane","emailSentAt":"2026-09-03"},"notes":"owner note","statusNote":"phone screen","agentTag":{"deep":[1,2]}}',
			'2026-09-01T12:00:00.000Z', '2026-09-02T09:30:00.000Z'),
			('plain-role', 'Beta', 'beta', 'Role', 'review', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}',
			'2026-09-01T11:00:00.000Z', '2026-09-01T11:00:00.000Z')`,
		`INSERT INTO companies (slug, name, data, updatedAt) VALUES ('acme', 'Acme', '{"quickTake":"Robots.","facts":["one","two"],
			"profile":{"website":"https://example.com","founded":2015},"reviews":[{"source":"Example","rating":4.2,"ratingScale":5}],"customField":"kept"}', '2026-09-01T12:00:00.000Z')`,
		`INSERT INTO events (jobId, at, actor, action, detail) VALUES ('acme-staff', '2026-09-01T12:00:00.000Z', 'agent:laptop', 'Created', 'found it'),
			(NULL, '2026-09-01T12:05:00.000Z', 'system', 'Ran search', '')`,
		`INSERT INTO answers (id, question, answer, jobIds, createdAt, answeredAt) VALUES ('work-auth', 'Authorized to work?', 'Yes', '["acme-staff"]', '2026-09-01T12:00:00.000Z', '2026-09-01T12:10:00.000Z'),
			('salary', 'Salary expectation?', '', '[]', '2026-09-01T12:20:00.000Z', NULL)`,
		`INSERT INTO files (id, jobId, name, kind, mime, size, createdAt, actor) VALUES ('file-1', 'acme-staff', 'cover.pdf', 'cover-letter', 'application/pdf', 2048, '2026-09-01T13:00:00.000Z', 'agent:laptop')`,
		`INSERT INTO tokens (id, name, hash, createdAt, lastUsedAt, revokedAt) VALUES ('tok-1', 'laptop', 'deadbeef', '2026-09-01T10:00:00.000Z', '2026-09-02T10:00:00.000Z', NULL)`,
		`INSERT INTO config (key, value) VALUES ('search', '{"minScore":3}')`,
	}
	for _, statement := range statements {
		if _, err := raw.Exec(statement); err != nil {
			t.Fatalf("build prototype db: %v\n%s", err, statement)
		}
	}
	if withCompanySlug {
		if _, err := raw.Exec(`INSERT INTO emails (id, jobId, toAddrs, ccAddrs, subject, body, kind, status, createdBy, createdAt, approvedBy, approvedAt, sentAt, messageId, attempts, companySlug)
			VALUES ('mail-1', 'acme-staff', '["jane@example.com"]', '[]', 'Hello', 'Hi Jane', 'follow-up', 'sent', 'agent:laptop', '2026-09-03T08:00:00.000Z', 'Bret',
			'2026-09-03T08:30:00.000Z', '2026-09-03T09:00:00.000Z', '<id@example.com>', 1, 'acme')`); err != nil {
			t.Fatalf("insert prototype email: %v", err)
		}
	} else if _, err := raw.Exec(`INSERT INTO emails (id, jobId, toAddrs, ccAddrs, subject, body, kind, status, createdBy, createdAt, attempts)
			VALUES ('mail-1', 'acme-staff', 'jane@example.com, sam@example.com', '[]', 'Hello', 'Hi Jane', 'follow-up', 'draft', 'agent:laptop', '2026-09-03T08:00:00.000Z', 0)`); err != nil {
		t.Fatalf("insert prototype email: %v", err)
	}
}

func openIn(t *testing.T, dir, version string) *sqlite.Store {
	t.Helper()
	opened, err := sqlite.Open(t.Context(), sqlite.Options{Dir: dir, AppVersion: version})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	return opened
}

func TestMigratesPrototypeDB(t *testing.T) {
	for _, withCompanySlug := range []bool{true, false} {
		name := "with the late emails.companySlug column"
		if !withCompanySlug {
			name = "without it (an older prototype file)"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			buildPrototypeDB(t, dir, withCompanySlug)
			opened := openIn(t, dir, "1.2.3")

			if err := opened.View(t.Context(), func(tx store.Tx) error {
				job, err := tx.Jobs().Get(t.Context(), "acme-staff")
				if err != nil {
					t.Fatalf("job: %v", err)
				}
				if job.Company != "Acme" || job.Title != "Staff Engineer" || job.Status != domain.JobStatusApplied || *job.Score != 80 ||
					job.WorkType != domain.WorkTypeHybrid || *job.SalaryMin != 150000 || *job.SalaryMax != 190000 || job.CompanySlug != "acme" {
					t.Errorf("job columns lost: %+v", job)
				}
				if got := domain.FormatTimestamp(job.AppliedAt); got != "2026-09-02T09:30:00.000Z" {
					t.Errorf("appliedAt = %q", got)
				}
				if job.Description != "A synthetic role." || len(job.Reasons) != 2 || len(job.Contacts) != 1 || job.Contacts[0].EmailStatus != domain.EmailCheckVerified ||
					job.Followup.Subject != "Hello" || job.Notes != "owner note" {
					t.Errorf("job data cell lost: %+v", job)
				}
				if got := domain.FormatTimestamp(job.Followup.EmailSentAt); got != "2026-09-03T00:00:00.000Z" {
					t.Errorf("a bare date in the data cell should read as midnight UTC, got %q", got)
				}
				if job.StatusNote != "phone screen" || string(job.Extras["agentTag"]) != `{"deep":[1,2]}` || len(job.Extras) != 1 {
					t.Errorf("fields the domain has no name for must survive as extras: %v", job.Extras)
				}
				if len(job.Writers) != 0 {
					t.Errorf("prototype rows have no owner-written fields: %v", job.Writers)
				}
				plain, err := tx.Jobs().Get(t.Context(), "plain-role")
				if err != nil || plain.Score != nil || plain.URL != "" {
					t.Errorf("a row with NULL columns should read as unset: %+v, %v", plain, err)
				}
				all, _ := tx.Jobs().List(t.Context(), jobs.Filter{})
				if len(all) != 2 || all[0].ID != "acme-staff" {
					t.Errorf("jobs list = %d, first %v", len(all), all[0].ID)
				}

				company, err := tx.Companies().Get(t.Context(), "acme")
				if err != nil || company.QuickTake != "Robots." || *company.Profile.Founded != 2015 || len(company.Reviews) != 1 ||
					string(company.Extras["customField"]) != `"kept"` {
					t.Errorf("company lost: %+v, %v", company, err)
				}
				logged, _ := tx.Events().List(t.Context(), events.Filter{})
				if len(logged) != 2 || logged[0].Action != "Ran search" || logged[0].JobID != "" || logged[1].JobID != "acme-staff" {
					t.Errorf("events lost: %+v", logged)
				}
				answerList, _ := tx.Answers().List(t.Context())
				if len(answerList) != 2 || answerList[0].JobIDs[0] != "acme-staff" || !answerList[1].IsUnanswered() || !answerList[1].AnsweredAt.IsZero() {
					t.Errorf("answers lost: %+v", answerList)
				}
				file, err := tx.Files().Get(t.Context(), "file-1")
				if err != nil || file.Size != 2048 || file.JobID != "acme-staff" {
					t.Errorf("file lost: %+v, %v", file, err)
				}
				token, err := tx.Tokens().GetByHash(t.Context(), "deadbeef")
				if err != nil || token.Name != "laptop" || token.IsRevoked() {
					t.Errorf("token lost: %+v, %v", token, err)
				}
				search, err := tx.Settings().Get(t.Context(), "search")
				if err != nil || search != `{"minScore":3}` {
					t.Errorf("config lost: %q, %v", search, err)
				}
				email, err := tx.Emails().Get(t.Context(), "mail-1")
				if err != nil || email.Subject != "Hello" || len(email.To) == 0 || email.Version != 1 {
					t.Errorf("email lost or not at version 1: %+v, %v", email, err)
				}
				if withCompanySlug {
					if email.Status != domain.EmailStatusSent || email.CompanySlug != "acme" || email.To[0] != "jane@example.com" {
						t.Errorf("sent email lost: %+v", email)
					}
				} else if len(email.To) != 2 || email.To[1] != "sam@example.com" {
					t.Errorf("a hand-typed comma list of recipients must still be read: %v", email.To)
				}
				return nil
			}); err != nil {
				t.Fatalf("view: %v", err)
			}

			// The original was copied aside, verified, before anything changed.
			backups, _ := filepath.Glob(filepath.Join(opened.BackupDir(), "hussla-*-pre-migrate.db"))
			if len(backups) != 1 {
				t.Fatalf("expected one pre-migrate backup, found %v", backups)
			}
			backup, err := sql.Open("sqlite", "file:"+backups[0]+"?mode=ro")
			if err != nil {
				t.Fatal(err)
			}
			defer backup.Close() //nolint:errcheck // closing a read-only handle loses nothing
			var jobCount int
			if err := backup.QueryRow(`SELECT COUNT(*) FROM jobs`).Scan(&jobCount); err != nil || jobCount != 2 {
				t.Errorf("the backup should hold the original 2 jobs: %d, %v", jobCount, err)
			}
			var hasWriters int
			if err := backup.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name = 'writers'`).Scan(&hasWriters); err != nil || hasWriters != 0 {
				t.Errorf("the backup must be the pre-migration file (writers column present: %d, %v)", hasWriters, err)
			}

			// Reopening migrates nothing and backs up nothing.
			if err := opened.Close(); err != nil {
				t.Fatalf("close: %v", err)
			}
			reopened := openIn(t, dir, "1.2.3")
			again, _ := filepath.Glob(filepath.Join(reopened.BackupDir(), "hussla-*.db"))
			if len(again) != 1 {
				t.Errorf("a second open must not back up again: %v", again)
			}
		})
	}
}

func TestFreshInstallNeedsNoBackup(t *testing.T) {
	opened := openTemp(t)
	found, _ := filepath.Glob(filepath.Join(opened.BackupDir(), "*"))
	if len(found) != 0 {
		t.Fatalf("an empty database has nothing to back up, found %v", found)
	}
}

func TestRefusesADatabaseFromANewerBuild(t *testing.T) {
	dir := t.TempDir()
	first := openIn(t, dir, "2.0.0")
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	raw, err := sql.Open("sqlite", filepath.Join(dir, "hussla.db"))
	if err != nil {
		t.Fatal(err)
	}
	// One past the newest migration this build has, whatever that is when the test runs.
	var known int
	if err := raw.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&known); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO schema_migrations (version, name, appliedAt, appVersion) VALUES (?, 'future', '2027-01-01T00:00:00.000Z', '9.9.9')`, known+1); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = sqlite.Open(t.Context(), sqlite.Options{Dir: dir, AppVersion: "2.0.0"})
	var downgrade *sqlite.DowngradeError
	if !errors.As(err, &downgrade) {
		t.Fatalf("want a DowngradeError, got %v", err)
	}
	if downgrade.DataVersion != known+1 || downgrade.KnownVersion != known || downgrade.WrittenBy != "9.9.9" {
		t.Errorf("downgrade details wrong: %+v", downgrade)
	}
	if !strings.Contains(err.Error(), "9.9.9") {
		t.Errorf("the message should name the version to run: %v", err)
	}
}

func TestRefusesAGapInAppliedMigrations(t *testing.T) {
	dir := t.TempDir()
	first := openIn(t, dir, "1")
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", filepath.Join(dir, "hussla.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`DELETE FROM schema_migrations WHERE version = 1`); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := sqlite.Open(t.Context(), sqlite.Options{Dir: dir}); err == nil || !strings.Contains(err.Error(), "gap") {
		t.Fatalf("want a refusal naming the gap, got %v", err)
	}
}

func TestRefusesADamagedDatabaseAndPointsToTheLatestBackup(t *testing.T) {
	dir := t.TempDir()
	first := openIn(t, dir, "1")
	if err := first.Atomically(t.Context(), func(tx store.Tx) error {
		return tx.Settings().Set(t.Context(), "precious", "value")
	}); err != nil {
		t.Fatal(err)
	}
	backup, err := first.Backup(t.Context(), "daily")
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(filepath.Join(dir, "hussla.db"+suffix))
	}
	if err := os.WriteFile(filepath.Join(dir, "hussla.db"), []byte(strings.Repeat("this is not a database", 500)), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = sqlite.Open(t.Context(), sqlite.Options{Dir: dir})
	var corrupt *sqlite.CorruptError
	if !errors.As(err, &corrupt) {
		t.Fatalf("want a CorruptError, got %v", err)
	}
	if corrupt.LatestBackup != backup || !strings.Contains(err.Error(), backup) {
		t.Errorf("the error should point at the latest backup %s: %v", backup, err)
	}

	// Following the advice works: copy the backup over the file and start again.
	restored, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hussla.db"), restored, 0o600); err != nil {
		t.Fatal(err)
	}
	again := openIn(t, dir, "1")
	if err := again.View(t.Context(), func(tx store.Tx) error {
		value, err := tx.Settings().Get(t.Context(), "precious")
		if err != nil || value != "value" {
			t.Errorf("restored data = %q, %v", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDailyBackupAndPruning(t *testing.T) {
	now := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	opened, err := sqlite.Open(t.Context(), sqlite.Options{Dir: t.TempDir(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	made, err := opened.BackupDaily(t.Context())
	if err != nil || !made {
		t.Fatalf("first daily = (%v, %v), want made", made, err)
	}
	now = now.Add(23 * time.Hour)
	if made, err = opened.BackupDaily(t.Context()); err != nil || made {
		t.Fatalf("daily within a day = (%v, %v), want not made", made, err)
	}
	for day := 0; day < 9; day++ {
		now = now.Add(25 * time.Hour)
		if made, err = opened.BackupDaily(t.Context()); err != nil || !made {
			t.Fatalf("daily on day %d = (%v, %v), want made", day, made, err)
		}
	}
	found, _ := filepath.Glob(filepath.Join(opened.BackupDir(), "hussla-*-daily.db"))
	if len(found) != 7 {
		t.Fatalf("pruning should keep the newest 7 backups, found %d", len(found))
	}
	if !strings.Contains(found[len(found)-1], now.Format("20060102T150405")) {
		t.Errorf("the newest backup should survive: %v", found)
	}
}
