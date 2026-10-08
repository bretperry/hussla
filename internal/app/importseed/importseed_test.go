package importseed_test

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/sqlite"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/importseed"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/settings"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

var now = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

func sample(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "reference", "prototype", "seed-sample.json"))
	if err != nil {
		t.Fatalf("read the sample seed: %v", err)
	}
	return raw
}

// snapshot is everything the store holds, for "twice = same rows".
type snapshot struct {
	Jobs      []domain.Job
	Companies []domain.Company
	Answers   []domain.Answer
	Events    []domain.Event
	Config    map[string]string
}

func takeSnapshot(t *testing.T, s store.Store) snapshot {
	t.Helper()
	var snap snapshot
	if err := s.View(t.Context(), func(tx store.Tx) (err error) {
		if snap.Jobs, err = tx.Jobs().List(t.Context(), jobs.Filter{}); err != nil {
			return err
		}
		if snap.Companies, err = tx.Companies().List(t.Context()); err != nil {
			return err
		}
		if snap.Answers, err = tx.Answers().List(t.Context()); err != nil {
			return err
		}
		if snap.Events, err = tx.Events().List(t.Context(), events.Filter{Limit: 100000}); err != nil {
			return err
		}
		snap.Config, err = tx.Settings().All(t.Context())
		return err
	}); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	return snap
}

func stores(t *testing.T) map[string]store.Store {
	t.Helper()
	opened, err := sqlite.Open(t.Context(), sqlite.Options{Dir: t.TempDir(), AppVersion: "test"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	return map[string]store.Store{"sqlite": opened, "fake": fakes.New()}
}

func TestImportOfTheSampleSeedTwiceIsTheSameRows(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			first, err := importseed.Import(t.Context(), target, bytes.NewReader(sample(t)), now)
			if err != nil {
				t.Fatalf("first import: %v", err)
			}
			if first.Companies.Created != 1 || first.Jobs.Created != 2 || first.Answers.Created != 1 || first.Events.Created != 1 || !first.ConfigStored {
				t.Fatalf("first import report = %+v", first)
			}
			before := takeSnapshot(t, target)
			if len(before.Jobs) != 2 || len(before.Companies) != 1 || len(before.Answers) != 1 {
				t.Fatalf("rows after the first import: %d jobs, %d companies, %d answers", len(before.Jobs), len(before.Companies), len(before.Answers))
			}
			// The seed's own event, plus one line saying an import happened.
			if len(before.Events) != 2 {
				t.Fatalf("events after the first import = %+v", before.Events)
			}

			second, err := importseed.Import(t.Context(), target, bytes.NewReader(sample(t)), now.Add(time.Hour))
			if err != nil {
				t.Fatalf("second import: %v", err)
			}
			if second.Companies.Created+second.Jobs.Created+second.Answers.Created+second.Events.Created != 0 || second.ConfigStored {
				t.Fatalf("the second import must add nothing: %+v", second)
			}
			if after := takeSnapshot(t, target); !reflect.DeepEqual(before, after) {
				t.Fatalf("a second import changed the rows:\n before %#v\n after  %#v", before, after)
			}
		})
	}
}

func TestImportKeepsWhatTheSeedSaysAndInventsNothing(t *testing.T) {
	target := fakes.New()
	if _, err := importseed.Import(t.Context(), target, bytes.NewReader(sample(t)), now); err != nil {
		t.Fatalf("import: %v", err)
	}
	snap := takeSnapshot(t, target)
	job := snap.Jobs[0]
	for _, candidate := range snap.Jobs {
		if candidate.ID == "acme-robotics-senior-engineer" {
			job = candidate
		}
	}
	if job.ID != "acme-robotics-senior-engineer" || job.Company != "Acme Robotics" || *job.Score != 72 || *job.SalaryMin != 150000 || job.CompanySlug != "acme-robotics" {
		t.Errorf("job fields lost: %+v", job)
	}
	if job.WorkType != domain.WorkTypeUnknown {
		t.Errorf(`the sample's workType "Example workType" isn't a work type; it should be skipped, got %v`, job.WorkType)
	}
	if domain.FormatTimestamp(job.FoundAt) != "2026-09-01T12:00:00.000Z" || domain.FormatTimestamp(job.CreatedAt) != "2026-09-01T12:00:00.000Z" {
		t.Errorf("times should come from the seed, not the clock: found %v, created %v", job.FoundAt, job.CreatedAt)
	}
	if len(job.Contacts) != 2 || job.Followup.To != "recruiter@example.com" {
		t.Errorf("nested data lost: %+v", job.Contacts)
	}
	if len(job.Writers) != 0 {
		t.Errorf("imported fields have no owner writer: %v", job.Writers)
	}
	company := snap.Companies[0]
	// The sample's first review is rated 4.1 out of 3, which the domain refuses: it is dropped, the rest stays.
	if company.Slug != "acme-robotics" || len(company.Reviews) != 1 || *company.Profile.Founded != 3 || len(company.News) != 2 {
		t.Errorf("company lost: %+v", company)
	}
	if !strings.Contains(snap.Config[settings.KeySearchConfig], `"minScore":3`) {
		t.Errorf("search config not stored compactly: %q", snap.Config[settings.KeySearchConfig])
	}
	// "Example id" isn't a valid record id, so the answer's id comes from its question.
	if len(snap.Answers) != 1 || snap.Answers[0].ID != "example-question" {
		t.Errorf("answer id = %+v", snap.Answers)
	}
}

func TestImportNeverOverwritesWhatIsAlreadyStored(t *testing.T) {
	target := fakes.New()
	if _, err := importseed.Import(t.Context(), target, bytes.NewReader(sample(t)), now); err != nil {
		t.Fatal(err)
	}
	// The owner edits a job and the company, and changes the search config.
	if err := target.Atomically(t.Context(), func(tx store.Tx) error {
		job, _ := tx.Jobs().Get(t.Context(), "acme-robotics-senior-engineer")
		job.Notes = "my own note"
		if err := tx.Jobs().Update(t.Context(), job); err != nil {
			return err
		}
		return tx.Settings().Set(t.Context(), settings.KeySearchConfig, `{"minScore":9}`)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := importseed.Import(t.Context(), target, bytes.NewReader(sample(t)), now); err != nil {
		t.Fatal(err)
	}
	snap := takeSnapshot(t, target)
	for _, job := range snap.Jobs {
		if job.ID == "acme-robotics-senior-engineer" && job.Notes != "my own note" {
			t.Errorf("a re-import overwrote an edit: %q", job.Notes)
		}
	}
	if snap.Config[settings.KeySearchConfig] != `{"minScore":9}` {
		t.Errorf("a re-import overwrote the config: %q", snap.Config[settings.KeySearchConfig])
	}
}

func TestImportReportsBrokenRecordsAndKeepsTheRest(t *testing.T) {
	bundle := `{
	  "extra": 1,
	  "companies": [{"name": "Acme"}, {"name": "ACME!"}, {"slug": "no-name"}, "oops", {"name": "日本"}, {"name": "東京"}],
	  "jobs": [{"company": "Acme", "title": "Role"}, {"company": "Acme"}, {"company": "Beta", "title": "Applied one", "status": "applied"}],
	  "answers": [{"question": "Q one"}, {"answer": "no question"}],
	  "events": [{"at": "not a time", "action": "x"}, {"at": "2026-09-01T00:00:00Z", "actor": "a", "action": "kept"}]
	}`
	target := fakes.New()
	report, err := importseed.Import(t.Context(), target, strings.NewReader(bundle), now)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if report.Companies.Created != 4 || report.Companies.Skipped != 2 || report.Jobs.Created != 2 || report.Jobs.Skipped != 1 ||
		report.Answers.Created != 1 || report.Answers.Skipped != 1 || report.Events.Created != 1 || report.Events.Skipped != 1 {
		t.Errorf("report = %+v", report)
	}
	if len(report.Warnings) < 6 {
		t.Errorf("each skipped record and the unknown section should be named: %v", report.Warnings)
	}
	snap := takeSnapshot(t, target)
	var slugs []string
	for _, company := range snap.Companies {
		slugs = append(slugs, company.Slug)
	}
	// Collisions get a numeric suffix; names with nothing usable fall back to company-<n>.
	want := []string{"acme", "acme-2", "company-1", "company-2"}
	if !reflect.DeepEqual(slugs, want) {
		t.Errorf("company slugs = %v, want %v", slugs, want)
	}
	for _, job := range snap.Jobs {
		if job.Status == domain.JobStatusApplied && !job.AppliedAt.IsZero() {
			t.Errorf("an imported applied job must not get an invented applied date: %v", job.AppliedAt)
		}
	}
}

func TestImportIsAllOrNothing(t *testing.T) {
	target := fakes.New()
	if _, err := importseed.Import(t.Context(), target, strings.NewReader(`{"jobs": [{"company":"A","title":"B"}`), now); err == nil {
		t.Fatal("a truncated file must be refused")
	}
	if _, err := importseed.Import(t.Context(), target, strings.NewReader(`[1,2]`), now); err == nil {
		t.Fatal("a non-object must be refused")
	}
	if snap := takeSnapshot(t, target); len(snap.Jobs) != 0 || len(snap.Events) != 0 {
		t.Fatalf("a refused file left rows behind: %+v", snap)
	}
}
