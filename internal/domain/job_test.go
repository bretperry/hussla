// Tests for jobs: creation, the patch rule (absent/set/null, followup merge), appliedAt, and the property that a patch never touches a field it doesn't name.

package domain_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

var (
	createdAt = time.Date(2026, 9, 1, 14, 0, 0, 0, time.UTC)
	patchedAt = time.Date(2026, 9, 2, 15, 30, 0, 0, time.UTC)
)

func intPointer(value int) *int { return &value }

// applyJob runs ApplyJobPatch at patchedAt and unpacks the job and status move.
func applyJob(job domain.Job, patch domain.JobPatch, writer domain.Writer) (domain.Job, domain.JobStatusChange, error) {
	result, err := domain.ApplyJobPatch(job, patch, writer, patchedAt)
	return result.Record, result.StatusChange, err
}

func newTestJob(t *testing.T) domain.Job {
	t.Helper()
	job, err := domain.NewJob("example-co-staff-engineer", domain.JobPatch{
		Company: domain.Set("Example Co"),
		Title:   domain.Set("Staff Engineer"),
		Score:   domain.Set(intPointer(80)),
		Reasons: domain.Set([]string{"Go match"}),
		Followup: domain.Set(domain.FollowupPatch{
			To:      domain.Set("recruiter@example.com"),
			Subject: domain.Set("Staff Engineer: following up"),
		}),
	}, domain.WriterAgent, createdAt)
	if err != nil {
		t.Fatalf("NewJob: %v", err)
	}
	return job
}

func TestNewJobDefaultsAndDerivedFields(t *testing.T) {
	job := newTestJob(t)
	if job.Status != domain.JobStatusReview {
		t.Errorf("status = %v, want review", job.Status)
	}
	if job.CompanySlug != "example-co" {
		t.Errorf("companySlug = %q, want example-co", job.CompanySlug)
	}
	if !job.CreatedAt.Equal(createdAt) || !job.UpdatedAt.Equal(createdAt) {
		t.Errorf("timestamps = %v / %v, want %v", job.CreatedAt, job.UpdatedAt, createdAt)
	}
	if !job.AppliedAt.IsZero() {
		t.Errorf("appliedAt = %v, want unset for a job in review", job.AppliedAt)
	}
}

func TestNewJobRefusesMissingBasics(t *testing.T) {
	cases := []struct {
		name  string
		id    string
		patch domain.JobPatch
		field string
	}{
		{"no company", "x", domain.JobPatch{Title: domain.Set("Engineer")}, "company"},
		{"blank title", "x", domain.JobPatch{Company: domain.Set("Example Co"), Title: domain.Set("  ")}, "title"},
		{"bad id", "Not A Slug", domain.JobPatch{Company: domain.Set("Example Co"), Title: domain.Set("Engineer")}, "id"},
		{"score too high", "x", domain.JobPatch{Company: domain.Set("A"), Title: domain.Set("B"), Score: domain.Set(intPointer(101))}, "score"},
		{"negative pay", "x", domain.JobPatch{Company: domain.Set("A"), Title: domain.Set("B"), SalaryMin: domain.Set(intPointer(-1))}, "salaryMin"},
		{"nameless contact", "x", domain.JobPatch{Company: domain.Set("A"), Title: domain.Set("B"), Contacts: domain.Set([]domain.Contact{{Role: "Recruiter"}})}, "contacts"},
		{"extra shadows a field", "x", domain.JobPatch{Company: domain.Set("A"), Title: domain.Set("B"), Extras: domain.ExtrasPatch{"status": domain.Set(domain.RawJSON(`"x"`))}}, "status"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := domain.NewJob(testCase.id, testCase.patch, domain.WriterAgent, createdAt)
			var validationError *domain.ValidationError
			if !errors.As(err, &validationError) || validationError.Field != testCase.field {
				t.Fatalf("err = %v, want a ValidationError on %q", err, testCase.field)
			}
		})
	}
}

func TestNewJobStraightToAppliedStampsAppliedAt(t *testing.T) {
	job, err := domain.NewJob("a-b", domain.JobPatch{
		Company: domain.Set("A"), Title: domain.Set("B"), Status: domain.Set(domain.JobStatusApplied),
	}, domain.WriterAgent, createdAt)
	if err != nil {
		t.Fatal(err)
	}
	if !job.AppliedAt.Equal(createdAt) {
		t.Fatalf("appliedAt = %v, want %v", job.AppliedAt, createdAt)
	}
}

func TestApplyJobPatchStatusAndAppliedAt(t *testing.T) {
	earlier := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		name          string
		from          domain.JobStatus
		existing      time.Time
		patch         domain.JobPatch
		wantAppliedAt time.Time
		wantChanged   bool
	}{
		{"review to applied stamps now", domain.JobStatusReview, time.Time{}, domain.JobPatch{Status: domain.Set(domain.JobStatusApplied)}, patchedAt, true},
		{"applied keeps an existing date", domain.JobStatusQueued, earlier, domain.JobPatch{Status: domain.Set(domain.JobStatusApplied)}, earlier, true},
		{"applied with an explicit date uses it", domain.JobStatusReview, time.Time{}, domain.JobPatch{Status: domain.Set(domain.JobStatusApplied), AppliedAt: domain.Set(earlier)}, earlier, true},
		{"applied to applied is no move", domain.JobStatusApplied, time.Time{}, domain.JobPatch{Status: domain.Set(domain.JobStatusApplied)}, time.Time{}, false},
		{"applied to screening leaves it", domain.JobStatusApplied, earlier, domain.JobPatch{Status: domain.Set(domain.JobStatusScreening)}, earlier, true},
		{"review to interviewing doesn't stamp", domain.JobStatusReview, time.Time{}, domain.JobPatch{Status: domain.Set(domain.JobStatusInterviewing)}, time.Time{}, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			job := newTestJob(t)
			job.Status, job.AppliedAt = testCase.from, testCase.existing
			next, change, err := applyJob(job, testCase.patch, domain.WriterAgent)
			if err != nil {
				t.Fatal(err)
			}
			if !next.AppliedAt.Equal(testCase.wantAppliedAt) {
				t.Errorf("appliedAt = %v, want %v", next.AppliedAt, testCase.wantAppliedAt)
			}
			if change.Changed != testCase.wantChanged || (change.Changed && (change.From != testCase.from || change.To != next.Status)) {
				t.Errorf("change = %+v, want changed=%v from %v", change, testCase.wantChanged, testCase.from)
			}
		})
	}
}

func TestApplyJobPatchFollowupMergesByKey(t *testing.T) {
	job := newTestJob(t)
	next, _, err := applyJob(job, domain.JobPatch{
		Followup: domain.Set(domain.FollowupPatch{EmailSentAt: domain.Set(patchedAt), Subject: domain.Clear[string]()}),
	}, domain.WriterAgent)
	if err != nil {
		t.Fatal(err)
	}
	want := domain.Followup{To: "recruiter@example.com", EmailSentAt: patchedAt}
	if !reflect.DeepEqual(next.Followup, want) {
		t.Fatalf("followup = %+v, want %+v", next.Followup, want)
	}
	cleared, _, err := applyJob(next, domain.JobPatch{Followup: domain.Clear[domain.FollowupPatch]()}, domain.WriterAgent)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cleared.Followup, domain.Followup{}) {
		t.Fatalf("followup after null = %+v, want empty", cleared.Followup)
	}
}

func TestApplyJobPatchListsReplaceWholeAndNullClears(t *testing.T) {
	job := newTestJob(t)
	next, _, err := applyJob(job, domain.JobPatch{
		Reasons: domain.Set([]string{"Remote"}),
		Score:   domain.Clear[*int](),
		Extras:  domain.ExtrasPatch{"statusNote2": domain.Set(domain.RawJSON(`{"a":1}`))},
	}, domain.WriterAgent)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Reasons, []string{"Remote"}) {
		t.Errorf("reasons = %v, want [Remote] (replaced, not appended)", next.Reasons)
	}
	if next.Score != nil {
		t.Errorf("score = %v, want nil after null", *next.Score)
	}
	if next.Extras["statusNote2"] != `{"a":1}` {
		t.Errorf("extras = %v", next.Extras)
	}
	again, _, err := applyJob(next, domain.JobPatch{Extras: domain.ExtrasPatch{"statusNote2": domain.Clear[domain.RawJSON]()}}, domain.WriterAgent)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Extras) != 0 {
		t.Errorf("extras after null = %v, want none", again.Extras)
	}
}

func TestApplyJobPatchRefusesClearingRequiredFields(t *testing.T) {
	job := newTestJob(t)
	for name, patch := range map[string]domain.JobPatch{
		"company": {Company: domain.Clear[string]()},
		"title":   {Title: domain.Set("")},
		"status":  {Status: domain.Clear[domain.JobStatus]()},
	} {
		if _, _, err := applyJob(job, patch, domain.WriterAgent); err == nil {
			t.Errorf("clearing %s: want an error", name)
		}
	}
}

func TestEmptyPatchChangesNothing(t *testing.T) {
	job := newTestJob(t)
	next, change, err := applyJob(job, domain.JobPatch{}, domain.WriterAgent)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next, job) || change.Changed {
		t.Fatalf("an empty patch changed the job:\n got %+v\nwant %+v", next, job)
	}
}

func TestJobStatusesFollowConfig(t *testing.T) {
	if got := domain.JobStatusFailed.String(); got != config.JobStatusOrder[len(config.JobStatusOrder)-1] {
		t.Fatalf("last status = %q; domain.JobStatus and config.JobStatusOrder are out of step", got)
	}
	for index, name := range config.JobStatusOrder {
		status, err := domain.ParseJobStatus(name)
		if err != nil || int(status) != index || status.String() != name {
			t.Errorf("status %q parses to %v (%v), want member %d", name, status, err, index)
		}
	}
	if _, err := domain.ParseJobStatus("hired"); err == nil {
		t.Error(`ParseJobStatus("hired"): want an error`)
	}
}

func TestJobIDFor(t *testing.T) {
	if id, ok := domain.JobIDFor("Example Co", "Senior Engineer, AI"); !ok || id != "example-co-senior-engineer-ai" {
		t.Errorf("JobIDFor = %q, %v", id, ok)
	}
	if _, ok := domain.JobIDFor("株式会社", "エンジニア"); ok {
		t.Error("JobIDFor with no Latin letters: want ok=false so the caller picks an id")
	}
}

// patchableJobFields names each JobPatch field, how to draw a value for it, and how to name it
// in a patch (set or clear). The property below reads the same name off Job by reflection.
var patchableJobFields = []struct {
	name string
	fill func(t *rapid.T, patch *domain.JobPatch, clear bool)
}{
	{"Company", func(t *rapid.T, p *domain.JobPatch, _ bool) { p.Company = domain.Set(drawWord(t, "company")) }},
	{"Title", func(t *rapid.T, p *domain.JobPatch, _ bool) { p.Title = domain.Set(drawWord(t, "title")) }},
	{"Status", func(t *rapid.T, p *domain.JobPatch, _ bool) { p.Status = domain.Set(drawJobStatus(t)) }},
	{"StatusNote", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.StatusNote })},
	{"Score", func(t *rapid.T, p *domain.JobPatch, clear bool) { p.Score = intField(t, clear, 0, 100) }},
	{"URL", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.URL })},
	{"Location", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Location })},
	{"WorkType", func(t *rapid.T, p *domain.JobPatch, clear bool) {
		p.WorkType = setOrClear(clear, domain.WorkType(rapid.IntRange(0, 3).Draw(t, "workType")))
	}},
	{"SalaryMin", func(t *rapid.T, p *domain.JobPatch, clear bool) { p.SalaryMin = intField(t, clear, 0, 500000) }},
	{"SalaryMax", func(t *rapid.T, p *domain.JobPatch, clear bool) { p.SalaryMax = intField(t, clear, 0, 500000) }},
	{"PayText", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.PayText })},
	{"Compensation", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Compensation })},
	{"Source", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Source })},
	{"Resume", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Resume })},
	{"ResumeSent", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.ResumeSent })},
	{"FoundAt", timeField(func(p *domain.JobPatch) *domain.Field[time.Time] { return &p.FoundAt })},
	{"AppliedAt", timeField(func(p *domain.JobPatch) *domain.Field[time.Time] { return &p.AppliedAt })},
	{"NextAction", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.NextAction })},
	{"NextActionDue", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.NextActionDue })},
	{"HeadsUp", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.HeadsUp })},
	{"Description", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Description })},
	{"DescriptionFetchedAt", timeField(func(p *domain.JobPatch) *domain.Field[time.Time] { return &p.DescriptionFetchedAt })},
	{"PostingStatus", func(t *rapid.T, p *domain.JobPatch, clear bool) {
		p.PostingStatus = setOrClear(clear, domain.PostingStatus(rapid.IntRange(0, 2).Draw(t, "postingStatus")))
	}},
	{"WhyScore", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.WhyScore })},
	{"Reasons", stringsField(func(p *domain.JobPatch) *domain.Field[[]string] { return &p.Reasons })},
	{"ScamFlags", stringsField(func(p *domain.JobPatch) *domain.Field[[]string] { return &p.ScamFlags })},
	{"Contacts", func(t *rapid.T, p *domain.JobPatch, clear bool) { p.Contacts = setOrClear(clear, drawContacts(t)) }},
	{"BestChannel", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.BestChannel })},
	{"Followup", func(t *rapid.T, p *domain.JobPatch, clear bool) {
		p.Followup = setOrClear(clear, domain.FollowupPatch{Body: domain.Set(drawWord(t, "body"))})
	}},
	{"CompanyNotes", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.CompanyNotes })},
	{"RoleNotes", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.RoleNotes })},
	{"Sources", stringsField(func(p *domain.JobPatch) *domain.Field[[]string] { return &p.Sources })},
	{"Notes", stringField(func(p *domain.JobPatch) *domain.Field[string] { return &p.Notes })},
}

// TestEveryPatchFieldIsInTheProperty fails when JobPatch grows a field the property doesn't cover.
func TestEveryPatchFieldIsInTheProperty(t *testing.T) {
	covered := map[string]bool{"Extras": true}
	for _, field := range patchableJobFields {
		covered[field.name] = true
	}
	patchType := reflect.TypeFor[domain.JobPatch]()
	for index := range patchType.NumField() {
		if name := patchType.Field(index).Name; !covered[name] {
			t.Errorf("JobPatch.%s isn't in patchableJobFields; add it so the property covers it", name)
		}
	}
}

// Property: a patch never changes a field it doesn't name. The only fields that move without
// being named are derived ones: UpdatedAt, CompanySlug (from Company), and AppliedAt (stamped on a
// move into applied when it was empty).
func TestPatchNeverTouchesUnnamedFields(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		job := drawJob(t)
		var patch domain.JobPatch
		named := map[string]bool{}
		for _, field := range patchableJobFields {
			switch rapid.IntRange(0, 2).Draw(t, field.name) {
			case 1:
				field.fill(t, &patch, false)
				named[field.name] = true
			case 2:
				if field.name == "Company" || field.name == "Title" || field.name == "Status" {
					continue // required: clearing is refused, tested above
				}
				field.fill(t, &patch, true)
				named[field.name] = true
			}
		}
		extraKey := rapid.SampledFrom([]string{"", "agentNote", "fetchedBy"}).Draw(t, "extraKey")
		if extraKey != "" {
			patch.Extras = domain.ExtrasPatch{extraKey: domain.Set(domain.RawJSON(`"x"`))}
		}
		next, change, err := applyJob(job, patch, domain.WriterAgent)
		if err != nil {
			t.Fatalf("ApplyJobPatch: %v", err)
		}
		before, after := reflect.ValueOf(job), reflect.ValueOf(next)
		for index := range before.NumField() {
			name := before.Type().Field(index).Name
			if named[name] || name == "UpdatedAt" || name == "CompanySlug" || name == "Writers" {
				continue
			}
			if name == "AppliedAt" && change.Changed && next.Status == domain.JobStatusApplied && job.AppliedAt.IsZero() {
				continue
			}
			if name == "Extras" {
				for key, value := range job.Extras {
					if key != extraKey && next.Extras[key] != value {
						t.Fatalf("extra %q changed though the patch didn't name it", key)
					}
				}
				continue
			}
			if !reflect.DeepEqual(before.Field(index).Interface(), after.Field(index).Interface()) {
				t.Fatalf("%s changed though the patch didn't name it:\n before %#v\n after  %#v", name,
					before.Field(index).Interface(), after.Field(index).Interface())
			}
		}
		if named["Company"] && next.CompanySlug != domain.Slugify(next.Company) {
			t.Fatalf("companySlug %q doesn't follow company %q", next.CompanySlug, next.Company)
		}
	})
}

// Property: applying the same patch twice gives the same job as applying it once (a retried PATCH is a no-op).
func TestPatchIsIdempotent(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		job := drawJob(t)
		var patch domain.JobPatch
		for _, field := range patchableJobFields {
			if rapid.Bool().Draw(t, field.name) {
				field.fill(t, &patch, false)
			}
		}
		once, _, err := applyJob(job, patch, domain.WriterAgent)
		if err != nil {
			t.Fatal(err)
		}
		twice, change, err := applyJob(once, patch, domain.WriterAgent)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(once, twice) || change.Changed {
			t.Fatalf("second apply changed the job:\n once  %+v\n twice %+v", once, twice)
		}
	})
}

func drawWord(t *rapid.T, label string) string {
	return rapid.StringMatching(`[A-Za-z][A-Za-z0-9 ]{0,15}`).Draw(t, label)
}

func drawJobStatus(t *rapid.T) domain.JobStatus {
	return domain.JobStatus(rapid.IntRange(0, len(config.JobStatusOrder)-1).Draw(t, "status"))
}

func drawTime(t *rapid.T, label string) time.Time {
	if rapid.Bool().Draw(t, label+"Unset") {
		return time.Time{}
	}
	return time.Unix(rapid.Int64Range(1_700_000_000, 1_900_000_000).Draw(t, label), 0).UTC()
}

func drawContacts(t *rapid.T) []domain.Contact {
	return rapid.SliceOfN(rapid.Custom(func(t *rapid.T) domain.Contact {
		return domain.Contact{Name: drawWord(t, "contactName"), Role: drawWord(t, "contactRole")}
	}), 0, 3).Draw(t, "contacts")
}

func drawOptionalInt(t *rapid.T, label string, low, high int) *int {
	if rapid.Bool().Draw(t, label+"Nil") {
		return nil
	}
	return intPointer(rapid.IntRange(low, high).Draw(t, label))
}

func drawJob(t *rapid.T) domain.Job {
	company := drawWord(t, "company")
	job := domain.Job{
		ID: "job-1", Company: company, CompanySlug: domain.Slugify(company), Title: drawWord(t, "title"),
		Status: drawJobStatus(t), StatusNote: drawWord(t, "statusNote"), Score: drawOptionalInt(t, "score", 0, 100),
		URL: drawWord(t, "url"), Location: drawWord(t, "location"),
		WorkType:  domain.WorkType(rapid.IntRange(0, 3).Draw(t, "workType")),
		SalaryMin: drawOptionalInt(t, "salaryMin", 0, 500000), SalaryMax: drawOptionalInt(t, "salaryMax", 0, 500000),
		PayText: drawWord(t, "payText"), Compensation: drawWord(t, "compensation"), Source: drawWord(t, "source"),
		Resume: drawWord(t, "resume"), ResumeSent: drawWord(t, "resumeSent"),
		FoundAt: drawTime(t, "foundAt"), AppliedAt: drawTime(t, "appliedAt"),
		NextAction: drawWord(t, "nextAction"), NextActionDue: drawWord(t, "nextActionDue"),
		HeadsUp: drawWord(t, "headsUp"), Description: drawWord(t, "description"),
		DescriptionFetchedAt: drawTime(t, "descriptionFetchedAt"),
		PostingStatus:        domain.PostingStatus(rapid.IntRange(0, 2).Draw(t, "postingStatus")),
		WhyScore:             drawWord(t, "whyScore"),
		Reasons:              rapid.SliceOfN(rapid.StringN(1, 10, -1), 0, 3).Draw(t, "reasons"),
		ScamFlags:            rapid.SliceOfN(rapid.StringN(1, 10, -1), 0, 3).Draw(t, "scamFlags"),
		Contacts:             drawContacts(t),
		BestChannel:          drawWord(t, "bestChannel"),
		Followup:             domain.Followup{To: drawWord(t, "followupTo"), EmailSentAt: drawTime(t, "emailSentAt")},
		CompanyNotes:         drawWord(t, "companyNotes"), RoleNotes: drawWord(t, "roleNotes"),
		Sources:   rapid.SliceOfN(rapid.StringN(1, 10, -1), 0, 3).Draw(t, "sources"),
		Notes:     drawWord(t, "notes"),
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}
	if rapid.Bool().Draw(t, "hasExtras") {
		job.Extras = domain.Extras{"agentNote": `"seen"`, "rank": `3`}
	}
	return job
}

func setOrClear[T any](clear bool, value T) domain.Field[T] {
	if clear {
		return domain.Clear[T]()
	}
	return domain.Set(value)
}

func intField(t *rapid.T, clear bool, low, high int) domain.Field[*int] {
	return setOrClear(clear, drawOptionalInt(t, "int", low, high))
}

func stringField(pick func(*domain.JobPatch) *domain.Field[string]) func(*rapid.T, *domain.JobPatch, bool) {
	return func(t *rapid.T, patch *domain.JobPatch, clear bool) {
		*pick(patch) = setOrClear(clear, drawWord(t, "string"))
	}
}

func stringsField(pick func(*domain.JobPatch) *domain.Field[[]string]) func(*rapid.T, *domain.JobPatch, bool) {
	return func(t *rapid.T, patch *domain.JobPatch, clear bool) {
		*pick(patch) = setOrClear(clear, rapid.SliceOfN(rapid.StringN(1, 10, -1), 0, 3).Draw(t, "strings"))
	}
}

func timeField(pick func(*domain.JobPatch) *domain.Field[time.Time]) func(*rapid.T, *domain.JobPatch, bool) {
	return func(t *rapid.T, patch *domain.JobPatch, clear bool) {
		*pick(patch) = setOrClear(clear, drawTime(t, "time"))
	}
}
