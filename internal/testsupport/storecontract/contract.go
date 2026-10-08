// The storage contract suite: one set of tests every store.Store implementation must pass.
// In the app: nothing at runtime (tests only).
// Used by: the SQLite adapter's tests (a temp file) and the in-memory fake's tests, so a use-case tested on the fake is tested on behaviour the real store has too.
// Uses: internal/app/* ports, internal/domain, pgregory.net/rapid.
//
// Assert outcomes (what a read returns), not calls. Each test gets a fresh, empty store.

package storecontract

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/app/companies"
	"github.com/bretperry/hussla/internal/app/emails"
	"github.com/bretperry/hussla/internal/app/events"
	"github.com/bretperry/hussla/internal/app/files"
	"github.com/bretperry/hussla/internal/app/jobs"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tokens"
	"github.com/bretperry/hussla/internal/domain"
)

// NewStore returns a fresh empty store for one test.
type NewStore func(t *testing.T) store.Store

// Run runs every contract test against stores from newStore.
func Run(t *testing.T, newStore NewStore) {
	t.Helper()
	cases := []struct {
		name string
		run  func(*testing.T, NewStore)
	}{
		{"JobsRoundTripEveryField", jobsRoundTrip},
		{"JobsCreateUpdateDelete", jobsCreateUpdateDelete},
		{"JobsListOrderAndFilter", jobsListOrderAndFilter},
		{"JobsRoundTripProperty", jobsRoundTripProperty},
		{"CompaniesRoundTripEveryField", companiesRoundTrip},
		{"CompaniesCreateUpdateList", companiesCreateUpdateList},
		{"CompaniesRoundTripProperty", companiesRoundTripProperty},
		{"CompanySlugCollisionsGetASuffix", companySlugAllocation},
		{"EventsAppendOnceAndList", eventsAppendOnceAndList},
		{"EventsSurviveTheirJob", eventsSurviveTheirJob},
		{"AnswersRoundTripAndOrder", answersRoundTrip},
		{"FilesRoundTrip", filesRoundTrip},
		{"TokensUniqueRevokeTouch", tokensBehaviour},
		{"SettingsSetGetAll", settingsBehaviour},
		{"EmailsRoundTripEveryField", emailsRoundTrip},
		{"EmailsReplaceIsCompareAndSwap", emailsReplaceIsCompareAndSwap},
		{"EmailsQueueAndHistory", emailsQueueAndHistory},
		{"AtomicallyRollsBackOnError", atomicallyRollsBack},
		{"AtomicallyRollsBackOnPanic", atomicallyRollsBackOnPanic},
		{"ViewRefusesWrites", viewRefusesWrites},
		{"ReturnedValuesAreCopies", returnedValuesAreCopies},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { c.run(t, newStore) })
	}
}

var background = context.Background()

func write(t testing.TB, s store.Store, work func(store.Tx) error) {
	t.Helper()
	if err := s.Atomically(background, work); err != nil {
		t.Fatalf("unit of work failed: %v", err)
	}
}

func read(t testing.TB, s store.Store, work func(store.Tx) error) {
	t.Helper()
	if err := s.View(background, work); err != nil {
		t.Fatalf("view failed: %v", err)
	}
}

func mustEqual(t testing.TB, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s differs:\n got  %#v\n want %#v", what, got, want)
	}
}

func expectError(t testing.TB, what string, got, want error) {
	t.Helper()
	if !errors.Is(got, want) {
		t.Fatalf("%s: got error %v, want %v", what, got, want)
	}
}

// --- jobs

func jobsRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	for _, want := range []domain.Job{fullJob("full-job"), bareJob("bare-job")} {
		write(t, s, func(tx store.Tx) error { return tx.Jobs().Create(background, want) })
		read(t, s, func(tx store.Tx) error {
			got, err := tx.Jobs().Get(background, want.ID)
			if err != nil {
				t.Fatalf("get %s: %v", want.ID, err)
			}
			mustEqual(t, "job "+want.ID, got, want)
			return nil
		})
	}
}

func jobsCreateUpdateDelete(t *testing.T, newStore NewStore) {
	s := newStore(t)
	job := fullJob("job-1")
	write(t, s, func(tx store.Tx) error { return tx.Jobs().Create(background, job) })
	err := s.Atomically(background, func(tx store.Tx) error { return tx.Jobs().Create(background, job) })
	expectError(t, "create twice", err, storeerr.ErrExists)

	changed := job
	changed.Title, changed.Status, changed.Score, changed.Followup.Body = "Staff Engineer", domain.JobStatusApplied, nil, "new body"
	write(t, s, func(tx store.Tx) error { return tx.Jobs().Update(background, changed) })
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Jobs().Get(background, "job-1")
		mustEqual(t, "updated job", got, changed)
		return nil
	})

	err = s.Atomically(background, func(tx store.Tx) error { return tx.Jobs().Update(background, bareJob("missing")) })
	expectError(t, "update missing", err, storeerr.ErrNotFound)
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Jobs().Delete(background, "missing") })
	expectError(t, "delete missing", err, storeerr.ErrNotFound)
	err = s.View(background, func(tx store.Tx) error { _, err := tx.Jobs().Get(background, "missing"); return err })
	expectError(t, "get missing", err, storeerr.ErrNotFound)

	write(t, s, func(tx store.Tx) error { return tx.Jobs().Delete(background, "job-1") })
	err = s.View(background, func(tx store.Tx) error { _, err := tx.Jobs().Get(background, "job-1"); return err })
	expectError(t, "get deleted", err, storeerr.ErrNotFound)
}

func jobsListOrderAndFilter(t *testing.T, newStore NewStore) {
	s := newStore(t)
	make3 := func(id, company string, status domain.JobStatus, created int) domain.Job {
		job := bareJob(id)
		job.Company, job.CompanySlug, job.Status, job.CreatedAt = company, domain.Slugify(company), status, at(created)
		return job
	}
	write(t, s, func(tx store.Tx) error {
		for _, job := range []domain.Job{
			make3("a", "Acme", domain.JobStatusReview, 1), make3("b", "Beta", domain.JobStatusApplied, 3),
			make3("c", "Acme", domain.JobStatusApplied, 3), make3("d", "Acme", domain.JobStatusApplied, 2),
		} {
			if err := tx.Jobs().Create(background, job); err != nil {
				return err
			}
		}
		return nil
	})
	ids := func(filter jobs.Filter) []string {
		var found []string
		read(t, s, func(tx store.Tx) error {
			list, err := tx.Jobs().List(background, filter)
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			for _, job := range list {
				found = append(found, job.ID)
			}
			return nil
		})
		return found
	}
	applied := domain.JobStatusApplied
	mustEqual(t, "all, newest first, ties by id", ids(jobs.Filter{}), []string{"b", "c", "d", "a"})
	mustEqual(t, "by status", ids(jobs.Filter{Status: &applied}), []string{"b", "c", "d"})
	mustEqual(t, "by company", ids(jobs.Filter{CompanySlug: "acme"}), []string{"c", "d", "a"})
	mustEqual(t, "status and company", ids(jobs.Filter{Status: &applied, CompanySlug: "acme"}), []string{"c", "d"})
	mustEqual(t, "limit", ids(jobs.Filter{Limit: 2}), []string{"b", "c"})
}

func jobsRoundTripProperty(t *testing.T, newStore NewStore) {
	rapid.Check(t, func(rt *rapid.T) {
		s := newStore(t)
		want := genJob().Draw(rt, "job")
		if err := s.Atomically(background, func(tx store.Tx) error { return tx.Jobs().Create(background, want) }); err != nil {
			rt.Fatalf("create: %v", err)
		}
		var got domain.Job
		if err := s.View(background, func(tx store.Tx) (err error) { got, err = tx.Jobs().Get(background, want.ID); return err }); err != nil {
			rt.Fatalf("get: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			rt.Fatalf("job round trip differs:\n got  %#v\n want %#v", got, want)
		}
	})
}

// --- companies

func companiesRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	bare := domain.Company{Slug: "bare", Name: "Bare", UpdatedAt: at(0)}
	for _, want := range []domain.Company{fullCompany("acme-robotics", "Acme Robotics"), bare} {
		write(t, s, func(tx store.Tx) error { return tx.Companies().Create(background, want) })
		read(t, s, func(tx store.Tx) error {
			got, err := tx.Companies().Get(background, want.Slug)
			if err != nil {
				t.Fatalf("get %s: %v", want.Slug, err)
			}
			mustEqual(t, "company "+want.Slug, got, want)
			return nil
		})
	}
}

func companiesCreateUpdateList(t *testing.T, newStore NewStore) {
	s := newStore(t)
	write(t, s, func(tx store.Tx) error {
		for _, company := range []domain.Company{
			{Slug: "zed", Name: "Zed", UpdatedAt: at(0)}, {Slug: "acme", Name: "acme", UpdatedAt: at(0)},
			{Slug: "acme-2", Name: "Acme", UpdatedAt: at(0)}, {Slug: "beta", Name: "Beta", UpdatedAt: at(0)},
		} {
			if err := tx.Companies().Create(background, company); err != nil {
				return err
			}
		}
		return nil
	})
	err := s.Atomically(background, func(tx store.Tx) error {
		return tx.Companies().Create(background, domain.Company{Slug: "beta", Name: "Other", UpdatedAt: at(0)})
	})
	expectError(t, "create twice", err, storeerr.ErrExists)
	err = s.Atomically(background, func(tx store.Tx) error {
		return tx.Companies().Update(background, domain.Company{Slug: "nope", Name: "Nope", UpdatedAt: at(0)})
	})
	expectError(t, "update missing", err, storeerr.ErrNotFound)

	write(t, s, func(tx store.Tx) error {
		return tx.Companies().Update(background, domain.Company{Slug: "beta", Name: "Beta Corp", QuickTake: "changed", UpdatedAt: at(9)})
	})
	read(t, s, func(tx store.Tx) error {
		list, err := tx.Companies().List(background)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		var slugs []string
		for _, company := range list {
			slugs = append(slugs, company.Slug)
		}
		mustEqual(t, "ordered by name ignoring case, ties by slug", slugs, []string{"acme", "acme-2", "beta", "zed"})
		changed, _ := tx.Companies().Get(background, "beta")
		mustEqual(t, "updated company", changed, domain.Company{Slug: "beta", Name: "Beta Corp", QuickTake: "changed", UpdatedAt: at(9)})
		return nil
	})
}

func companiesRoundTripProperty(t *testing.T, newStore NewStore) {
	rapid.Check(t, func(rt *rapid.T) {
		s := newStore(t)
		want := genCompany().Draw(rt, "company")
		if err := s.Atomically(background, func(tx store.Tx) error { return tx.Companies().Create(background, want) }); err != nil {
			rt.Fatalf("create: %v", err)
		}
		var got domain.Company
		if err := s.View(background, func(tx store.Tx) (err error) { got, err = tx.Companies().Get(background, want.Slug); return err }); err != nil {
			rt.Fatalf("get: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			rt.Fatalf("company round trip differs:\n got  %#v\n want %#v", got, want)
		}
	})
}

func companySlugAllocation(t *testing.T, newStore NewStore) {
	s := newStore(t)
	allocate := func(name string) (string, bool) {
		var slug string
		var existed bool
		write(t, s, func(tx store.Tx) (err error) {
			slug, existed, err = companies.AllocateSlug(background, tx.Companies(), name)
			if err != nil {
				return err
			}
			if existed {
				return nil
			}
			return tx.Companies().Create(background, domain.Company{Slug: slug, Name: name, UpdatedAt: at(0)})
		})
		return slug, existed
	}
	for _, step := range []struct {
		name    string
		slug    string
		existed bool
	}{
		{"Acme", "acme", false},
		{" acme ", "acme", true},   // the same company spelled differently
		{"ACME!", "acme-2", false}, // a different company with the same slug
		{"Acme?", "acme-3", false},
		{"日本", "company-1", false}, // nothing usable in the name
		{"東京", "company-2", false},
	} {
		slug, existed := allocate(step.name)
		if slug != step.slug || existed != step.existed {
			t.Fatalf("allocate %q = (%q, %v), want (%q, %v)", step.name, slug, existed, step.slug, step.existed)
		}
	}
}

// --- events

func eventsAppendOnceAndList(t *testing.T, newStore NewStore) {
	s := newStore(t)
	event := func(jobID, actor, action string, minute int) domain.Event {
		return domain.Event{JobID: jobID, At: at(minute), Actor: actor, Action: action, Detail: "detail " + action}
	}
	var first, second domain.Event
	write(t, s, func(tx store.Tx) (err error) {
		if first, err = tx.Events().Append(background, event("job-a", "Bret", "one", 1)); err != nil {
			return err
		}
		second, err = tx.Events().Append(background, event("", "agent:x", "two", 2))
		return err
	})
	if first.ID == 0 || second.ID <= first.ID {
		t.Fatalf("event ids must be set and grow: %d then %d", first.ID, second.ID)
	}
	write(t, s, func(tx store.Tx) error {
		inserted, err := tx.Events().AppendOnce(background, "key-1", event("job-a", "import", "three", 3))
		if err != nil || !inserted {
			t.Fatalf("first AppendOnce = (%v, %v), want inserted", inserted, err)
		}
		inserted, err = tx.Events().AppendOnce(background, "key-1", event("job-a", "import", "three again", 4))
		if err != nil || inserted {
			t.Fatalf("second AppendOnce = (%v, %v), want not inserted", inserted, err)
		}
		return nil
	})
	list := func(filter events.Filter) []string {
		var actions []string
		read(t, s, func(tx store.Tx) error {
			found, err := tx.Events().List(background, filter)
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			for _, e := range found {
				actions = append(actions, e.Action)
			}
			return nil
		})
		return actions
	}
	mustEqual(t, "newest first", list(events.Filter{}), []string{"three", "two", "one"})
	mustEqual(t, "by job", list(events.Filter{JobID: "job-a"}), []string{"three", "one"})
	mustEqual(t, "by actor", list(events.Filter{Actor: "agent:x"}), []string{"two"})
	mustEqual(t, "since", list(events.Filter{Since: at(2)}), []string{"three", "two"})
	mustEqual(t, "limit", list(events.Filter{Limit: 1}), []string{"three"})
	read(t, s, func(tx store.Tx) error {
		found, _ := tx.Events().List(background, events.Filter{Actor: "agent:x"})
		mustEqual(t, "a search-wide event keeps no job", found, []domain.Event{{ID: second.ID, At: at(2), Actor: "agent:x", Action: "two", Detail: "detail two"}})
		return nil
	})
}

func eventsSurviveTheirJob(t *testing.T, newStore NewStore) {
	s := newStore(t)
	write(t, s, func(tx store.Tx) error {
		if err := tx.Jobs().Create(background, bareJob("gone")); err != nil {
			return err
		}
		_, err := tx.Events().Append(background, domain.Event{JobID: "gone", At: at(1), Actor: "Bret", Action: "created"})
		return err
	})
	write(t, s, func(tx store.Tx) error { return tx.Jobs().Delete(background, "gone") })
	read(t, s, func(tx store.Tx) error {
		found, err := tx.Events().List(background, events.Filter{JobID: "gone"})
		if err != nil || len(found) != 1 {
			t.Fatalf("a deleted job's activity is the audit trail and stays: got %v, %v", found, err)
		}
		return nil
	})
}

// --- answers, files, settings

func answersRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	unanswered := domain.Answer{ID: "later", Question: "Salary?", CreatedAt: at(5)}
	write(t, s, func(tx store.Tx) error {
		if err := tx.Answers().Create(background, fullAnswer("auth")); err != nil {
			return err
		}
		return tx.Answers().Create(background, unanswered)
	})
	err := s.Atomically(background, func(tx store.Tx) error { return tx.Answers().Create(background, unanswered) })
	expectError(t, "create twice", err, storeerr.ErrExists)
	read(t, s, func(tx store.Tx) error {
		list, _ := tx.Answers().List(background)
		mustEqual(t, "oldest first", list, []domain.Answer{fullAnswer("auth"), unanswered})
		return nil
	})
	updated := fullAnswer("auth")
	updated.Answer, updated.JobIDs, updated.Writers = "Yes, with sponsorship.", nil, nil
	write(t, s, func(tx store.Tx) error { return tx.Answers().Update(background, updated) })
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Answers().Get(background, "auth")
		mustEqual(t, "updated answer", got, updated)
		return nil
	})
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Answers().Update(background, domain.Answer{ID: "nope"}) })
	expectError(t, "update missing", err, storeerr.ErrNotFound)
	write(t, s, func(tx store.Tx) error { return tx.Answers().Delete(background, "later") })
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Answers().Delete(background, "later") })
	expectError(t, "delete twice", err, storeerr.ErrNotFound)
}

func filesRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	cover := files.File{ID: "f1", JobID: "job-a", Name: "cover.pdf", Kind: "cover-letter", Mime: "application/pdf", Size: 12345, CreatedAt: at(2), Actor: "agent:x"}
	loose := files.File{ID: "f2", Name: "notes.txt", Kind: "file", Mime: "text/plain", Size: 0, CreatedAt: at(1), Actor: "Bret"}
	older := files.File{ID: "f0", JobID: "job-a", Name: "resume.pdf", Kind: "resume", Mime: "application/pdf", Size: 99, CreatedAt: at(1), Actor: "Bret"}
	write(t, s, func(tx store.Tx) error {
		for _, file := range []files.File{cover, loose, older} {
			if err := tx.Files().Create(background, file); err != nil {
				return err
			}
		}
		return nil
	})
	err := s.Atomically(background, func(tx store.Tx) error { return tx.Files().Create(background, cover) })
	expectError(t, "create twice", err, storeerr.ErrExists)
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Files().Get(background, "f2")
		mustEqual(t, "file without a job", got, loose)
		list, _ := tx.Files().ListByJob(background, "job-a")
		mustEqual(t, "a job's files, oldest first", list, []files.File{older, cover})
		return nil
	})
	write(t, s, func(tx store.Tx) error { return tx.Files().Delete(background, "f1") })
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Files().Delete(background, "f1") })
	expectError(t, "delete twice", err, storeerr.ErrNotFound)
	err = s.View(background, func(tx store.Tx) error { _, err := tx.Files().Get(background, "f1"); return err })
	expectError(t, "get deleted", err, storeerr.ErrNotFound)
}

func settingsBehaviour(t *testing.T, newStore NewStore) {
	s := newStore(t)
	err := s.View(background, func(tx store.Tx) error { _, err := tx.Settings().Get(background, "k"); return err })
	expectError(t, "get unset", err, storeerr.ErrNotFound)
	write(t, s, func(tx store.Tx) error {
		if err := tx.Settings().Set(background, "k", "one"); err != nil {
			return err
		}
		if err := tx.Settings().Set(background, "k", `{"two":2}`); err != nil {
			return err
		}
		return tx.Settings().Set(background, "other", "")
	})
	read(t, s, func(tx store.Tx) error {
		value, _ := tx.Settings().Get(background, "k")
		mustEqual(t, "latest value wins", value, `{"two":2}`)
		all, _ := tx.Settings().All(background)
		mustEqual(t, "all", all, map[string]string{"k": `{"two":2}`, "other": ""})
		return nil
	})
}

// --- tokens

func tokensBehaviour(t *testing.T, newStore NewStore) {
	s := newStore(t)
	laptop := tokens.Token{ID: "t1", Name: "laptop", Hash: "hash-1", CreatedAt: at(1)}
	phone := tokens.Token{ID: "t2", Name: "phone", Hash: "hash-2", CreatedAt: at(2)}
	write(t, s, func(tx store.Tx) error {
		if err := tx.Tokens().Create(background, phone); err != nil {
			return err
		}
		return tx.Tokens().Create(background, laptop)
	})
	for name, clash := range map[string]tokens.Token{
		"same id":   {ID: "t1", Name: "x", Hash: "hash-3", CreatedAt: at(3)},
		"same hash": {ID: "t3", Name: "x", Hash: "hash-1", CreatedAt: at(3)},
	} {
		err := s.Atomically(background, func(tx store.Tx) error { return tx.Tokens().Create(background, clash) })
		expectError(t, "create with "+name, err, storeerr.ErrExists)
	}
	write(t, s, func(tx store.Tx) error {
		found, err := tx.Tokens().GetByHash(background, "hash-1")
		if err != nil {
			t.Fatalf("get by hash: %v", err)
		}
		mustEqual(t, "token by hash", found, laptop)
		_, err = tx.Tokens().GetByHash(background, "nope")
		expectError(t, "unknown hash", err, storeerr.ErrNotFound)

		changed, err := tx.Tokens().Revoke(background, "t1", at(10))
		if err != nil || !changed {
			t.Fatalf("first revoke = (%v, %v), want changed", changed, err)
		}
		changed, err = tx.Tokens().Revoke(background, "t1", at(20))
		if err != nil || changed {
			t.Fatalf("second revoke = (%v, %v), want unchanged", changed, err)
		}
		_, err = tx.Tokens().Revoke(background, "nope", at(20))
		expectError(t, "revoke unknown", err, storeerr.ErrNotFound)

		if err := tx.Tokens().Touch(background, "t2", at(30)); err != nil {
			t.Fatalf("touch: %v", err)
		}
		if err := tx.Tokens().Touch(background, "t2", at(25)); err != nil {
			t.Fatalf("touch earlier: %v", err)
		}
		expectError(t, "touch unknown", tx.Tokens().Touch(background, "nope", at(30)), storeerr.ErrNotFound)
		return nil
	})
	read(t, s, func(tx store.Tx) error {
		list, _ := tx.Tokens().List(background)
		laptop.RevokedAt = at(10)
		phone.LastUsedAt = at(30)
		mustEqual(t, "oldest first; first revocation and latest use kept", list, []tokens.Token{laptop, phone})
		if !list[0].IsRevoked() || list[1].IsRevoked() {
			t.Fatalf("revoked flags wrong: %+v", list)
		}
		return nil
	})
}

// --- emails

func emailsRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	for _, want := range []domain.Email{fullEmail("full"), draftEmail("draft", at(1))} {
		write(t, s, func(tx store.Tx) error { return tx.Emails().Create(background, want) })
		read(t, s, func(tx store.Tx) error {
			got, err := tx.Emails().Get(background, want.ID)
			if err != nil {
				t.Fatalf("get %s: %v", want.ID, err)
			}
			mustEqual(t, "email "+want.ID, got, want)
			return nil
		})
	}
	err := s.Atomically(background, func(tx store.Tx) error { return tx.Emails().Create(background, fullEmail("full")) })
	expectError(t, "create twice", err, storeerr.ErrExists)
}

// emailsReplaceIsCompareAndSwap: the security model's approval rule. Two writers read the same
// draft; the first change wins and the second is refused instead of overwriting it.
func emailsReplaceIsCompareAndSwap(t *testing.T, newStore NewStore) {
	s := newStore(t)
	draft := draftEmail("e1", at(1))
	write(t, s, func(tx store.Tx) error { return tx.Emails().Create(background, draft) })

	approved, err := draft.Approve("Bret", draft.Version, at(5))
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	edited, err := draft.Edit(domain.EmailEdit{Subject: domain.Set("A different subject")})
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	write(t, s, func(tx store.Tx) error { return tx.Emails().Replace(background, draft, edited) })
	// The owner approves the version they read (1), but an agent edit already made it 2.
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Emails().Replace(background, draft, approved) })
	expectError(t, "approve after an edit", err, storeerr.ErrConflict)
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Emails().Get(background, "e1")
		mustEqual(t, "the edit stands", got, edited)
		return nil
	})

	// The same read replayed (a double click) loses too, even when the state is the same one.
	write(t, s, func(tx store.Tx) error { return tx.Emails().Replace(background, edited, mustApprove(t, edited, at(6))) })
	err = s.Atomically(background, func(tx store.Tx) error {
		return tx.Emails().Replace(background, edited, mustApprove(t, edited, at(7)))
	})
	expectError(t, "approving twice", err, storeerr.ErrConflict)

	ghost := draftEmail("ghost", at(1))
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Emails().Replace(background, ghost, ghost) })
	expectError(t, "replace missing", err, storeerr.ErrNotFound)
}

func mustApprove(t testing.TB, email domain.Email, now time.Time) domain.Email {
	t.Helper()
	approved, err := email.Approve("Bret", email.Version, now)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	return approved
}

func emailsQueueAndHistory(t *testing.T, newStore NewStore) {
	s := newStore(t)
	approvedAt := func(id string, minute int, status domain.EmailStatus) domain.Email {
		email := draftEmail(id, at(0))
		email.Status, email.ApprovedBy, email.ApprovedAt = status, "Bret", at(minute)
		return email
	}
	sent := func(id string, minute int) domain.Email {
		email := approvedAt(id, 1, domain.EmailStatusSent)
		email.SentAt = at(minute)
		return email
	}
	write(t, s, func(tx store.Tx) error {
		for _, email := range []domain.Email{
			approvedAt("late", 9, domain.EmailStatusApproved), approvedAt("tie-b", 5, domain.EmailStatusApproved),
			approvedAt("tie-a", 5, domain.EmailStatusApproved), approvedAt("busy", 4, domain.EmailStatusSending),
			draftEmail("plain", at(0)), sent("s1", 30), sent("s2", 40), sent("s3", 20),
		} {
			if err := tx.Emails().Create(background, email); err != nil {
				return err
			}
		}
		return nil
	})
	read(t, s, func(tx store.Tx) error {
		next, err := tx.Emails().NextApproved(background)
		if err != nil || next.ID != "tie-a" {
			t.Fatalf("NextApproved = %q, %v; want the longest-waiting, ties by id (tie-a)", next.ID, err)
		}
		sending, _ := tx.Emails().ListSending(background)
		if len(sending) != 1 || sending[0].ID != "busy" {
			t.Fatalf("ListSending = %+v", sending)
		}
		history, err := tx.Emails().SentHistory(background, at(25))
		if err != nil {
			t.Fatalf("history: %v", err)
		}
		mustEqual(t, "history from the sent rows", history, emails.SendHistory{LastSentAt: at(40), SentSince: 2})
		all, _ := tx.Emails().SentHistory(background, time.Time{})
		mustEqual(t, "history since the beginning", all, emails.SendHistory{LastSentAt: at(40), SentSince: 3})

		drafts := domain.EmailStatusDraft
		list, _ := tx.Emails().List(background, emails.Filter{Status: &drafts})
		if len(list) != 1 || list[0].ID != "plain" {
			t.Fatalf("List by status = %+v", list)
		}
		return nil
	})
	empty := newStore(t)
	read(t, empty, func(tx store.Tx) error {
		_, err := tx.Emails().NextApproved(background)
		expectError(t, "empty queue", err, storeerr.ErrNotFound)
		history, _ := tx.Emails().SentHistory(background, at(0))
		mustEqual(t, "no history", history, emails.SendHistory{})
		return nil
	})
}

// --- units of work

var errAbandon = errors.New("abandon the unit of work")

func atomicallyRollsBack(t *testing.T, newStore NewStore) {
	s := newStore(t)
	err := s.Atomically(background, func(tx store.Tx) error {
		if err := tx.Jobs().Create(background, bareJob("kept-out")); err != nil {
			return err
		}
		if _, err := tx.Events().Append(background, domain.Event{JobID: "kept-out", At: at(0), Actor: "x", Action: "created"}); err != nil {
			return err
		}
		return errAbandon
	})
	expectError(t, "the work's own error comes back", err, errAbandon)
	assertNothingStored(t, s)
}

func atomicallyRollsBackOnPanic(t *testing.T, newStore NewStore) {
	s := newStore(t)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the panic should propagate")
			}
		}()
		_ = s.Atomically(background, func(tx store.Tx) error {
			if err := tx.Jobs().Create(background, bareJob("kept-out")); err != nil {
				return err
			}
			panic("boom")
		})
	}()
	assertNothingStored(t, s)
	// The store still works afterwards.
	write(t, s, func(tx store.Tx) error { return tx.Jobs().Create(background, bareJob("after")) })
}

func assertNothingStored(t *testing.T, s store.Store) {
	t.Helper()
	read(t, s, func(tx store.Tx) error {
		found, _ := tx.Jobs().List(background, jobs.Filter{})
		logged, _ := tx.Events().List(background, events.Filter{})
		if len(found) != 0 || len(logged) != 0 {
			t.Fatalf("a failed unit of work left %d jobs and %d events behind", len(found), len(logged))
		}
		return nil
	})
}

func viewRefusesWrites(t *testing.T, newStore NewStore) {
	s := newStore(t)
	err := s.View(background, func(tx store.Tx) error { return tx.Jobs().Create(background, bareJob("nope")) })
	if err == nil {
		t.Fatal("a write inside View must fail")
	}
	assertNothingStored(t, s)
}

// returnedValuesAreCopies: mutating what a read returned must not change what is stored.
func returnedValuesAreCopies(t *testing.T, newStore NewStore) {
	s := newStore(t)
	write(t, s, func(tx store.Tx) error { return tx.Jobs().Create(background, fullJob("j")) })
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Jobs().Get(background, "j")
		got.Reasons[0] = "mutated"
		got.Extras["xText"] = `"mutated"`
		got.Writers["notes"] = domain.WriterAgent
		*got.Score = 1
		return nil
	})
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Jobs().Get(background, "j")
		mustEqual(t, "stored job", got, fullJob("j"))
		return nil
	})
}
