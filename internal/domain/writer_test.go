// Tests for field provenance: an agent can't clear or overwrite what the owner wrote, the owner can, results keep prior values, and a property that no agent patch changes an owner-written field.

package domain_test

import (
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/domain"
)

func ownerJob(t *testing.T) domain.Job {
	t.Helper()
	job := newTestJob(t)
	result, err := domain.ApplyJobPatch(job, domain.JobPatch{
		Notes:    domain.Set("Liked the team"),
		Status:   domain.Set(domain.JobStatusQueued),
		Followup: domain.Set(domain.FollowupPatch{Body: domain.Set("Owner's wording")}),
		Extras:   domain.ExtrasPatch{"ownerTag": domain.Set(domain.RawJSON(`"keep"`))},
	}, domain.WriterOwner, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	return result.Record
}

func TestAgentCannotChangeOwnerFields(t *testing.T) {
	job := ownerJob(t)
	cases := []struct {
		name  string
		patch domain.JobPatch
		want  []string
	}{
		{"overwrite", domain.JobPatch{Notes: domain.Set("agent text")}, []string{"notes"}},
		{"clear", domain.JobPatch{Notes: domain.Clear[string]()}, []string{"notes"}},
		{"two at once, sorted", domain.JobPatch{Status: domain.Set(domain.JobStatusApplied), Notes: domain.Set("x")}, []string{"notes", "status"}},
		{"followup key", domain.JobPatch{Followup: domain.Set(domain.FollowupPatch{Body: domain.Set("agent body")})}, []string{"followup.body"}},
		{"whole followup cleared", domain.JobPatch{Followup: domain.Clear[domain.FollowupPatch]()}, []string{"followup.body"}},
		{"extra", domain.JobPatch{Extras: domain.ExtrasPatch{"ownerTag": domain.Clear[domain.RawJSON]()}}, []string{"ownerTag"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := domain.ApplyJobPatch(job, testCase.patch, domain.WriterAgent, patchedAt)
			var refused *domain.OwnerFieldsError
			if !errors.As(err, &refused) || !errors.Is(err, domain.ErrOwnerField) || !slices.Equal(refused.Fields, testCase.want) {
				t.Fatalf("err = %v, want OwnerFieldsError on %v", err, testCase.want)
			}
			if _, err := domain.ApplyJobPatch(job, testCase.patch, domain.WriterOwner, patchedAt); err != nil {
				t.Fatalf("the owner's own patch: %v", err)
			}
		})
	}
}

func TestAgentMayWriteOtherFieldsAndResendOwnerValues(t *testing.T) {
	job := ownerJob(t)
	result, err := domain.ApplyJobPatch(job, domain.JobPatch{
		HeadsUp:  domain.Set("Posting closes Friday"),
		Notes:    domain.Set("Liked the team"), // the owner's value, unchanged: a resent full record isn't refused
		Followup: domain.Set(domain.FollowupPatch{Subject: domain.Set("Agent subject")}),
	}, domain.WriterAgent, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(result.Changed, []string{"followup.subject", "headsUp"}) {
		t.Fatalf("changed = %v", result.Changed)
	}
	if result.Before.HeadsUp != "" || result.Before.Followup.Subject != "Staff Engineer: following up" {
		t.Fatalf("before = %+v; the result must keep prior values for restore", result.Before)
	}
	if result.Record.Writers["notes"] != domain.WriterOwner || result.Record.Writers["followup.body"] != domain.WriterOwner {
		t.Fatalf("writers = %v; the owner's fields must stay protected", result.Record.Writers)
	}
	if _, owned := result.Record.Writers["headsUp"]; owned {
		t.Fatalf("writers = %v; an agent write isn't recorded as the owner's", result.Record.Writers)
	}
}

func TestOwnerOverwriteThenAgentCanWriteAgain(t *testing.T) {
	job := ownerJob(t)
	// The owner hands the field back by clearing it; the clear is the owner's last write, so it stays protected.
	cleared, err := domain.ApplyJobPatch(job, domain.JobPatch{Notes: domain.Clear[string]()}, domain.WriterOwner, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := domain.ApplyJobPatch(cleared.Record, domain.JobPatch{Notes: domain.Set("agent")}, domain.WriterAgent, patchedAt); !errors.Is(err, domain.ErrOwnerField) {
		t.Fatalf("err = %v; a field the owner cleared is still the owner's", err)
	}
}

func TestCompanyAndAnswerProvenance(t *testing.T) {
	company, _ := domain.NewCompany("Example Labs", createdAt)
	owned, err := domain.ApplyCompanyPatch(company, domain.CompanyPatch{Notes: domain.Set("Mine")}, domain.WriterOwner, patchedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := domain.ApplyCompanyPatch(owned.Record, domain.CompanyPatch{Notes: domain.Clear[string]()}, domain.WriterAgent, patchedAt); !errors.Is(err, domain.ErrOwnerField) {
		t.Fatalf("agent clearing the owner's company notes: err = %v", err)
	}
	answer, err := domain.NewAnswer("q", domain.AnswerPatch{Question: domain.Set("Notice period?")}, domain.WriterAgent, createdAt)
	if err != nil {
		t.Fatal(err)
	}
	answered := applyAnswer(t, answer, domain.AnswerPatch{Answer: domain.Set("Two weeks")}, domain.WriterOwner, patchedAt)
	if _, err := domain.ApplyAnswerPatch(answered, domain.AnswerPatch{Answer: domain.Set("One week")}, domain.WriterAgent, patchedAt); !errors.Is(err, domain.ErrOwnerField) {
		t.Fatalf("agent rewriting the owner's answer: err = %v", err)
	}
	// An agent may still add the job that asked it again.
	if _, err := domain.ApplyAnswerPatch(answered, domain.AnswerPatch{JobIDs: domain.Set([]string{"job-2"})}, domain.WriterAgent, patchedAt); err != nil {
		t.Fatalf("agent adding a job id: %v", err)
	}
}

// apiFieldName is a Go field's API name: "StatusNote" → "statusNote", "URL" → "url", "LinkedInSentAt" → "linkedinSentAt".
func apiFieldName(goName string) string {
	switch {
	case goName == "URL":
		return "url"
	case strings.HasPrefix(goName, "LinkedIn"):
		return "linkedin" + strings.TrimPrefix(goName, "LinkedIn")
	}
	return strings.ToLower(goName[:1]) + goName[1:]
}

// ownableJobFields lists every API name a writer is tracked under: top-level fields and followup keys.
func ownableJobFields() []string {
	var names []string
	patchType := reflect.TypeFor[domain.JobPatch]()
	for index := range patchType.NumField() {
		name := patchType.Field(index).Name
		if name != "Extras" && name != "Followup" {
			names = append(names, apiFieldName(name))
		}
	}
	followupType := reflect.TypeFor[domain.FollowupPatch]()
	for index := range followupType.NumField() {
		names = append(names, "followup."+apiFieldName(followupType.Field(index).Name))
	}
	return names
}

// jobFieldValue reads a field by API name off a job ("followup.body" reads Followup.Body).
func jobFieldValue(job domain.Job, apiName string) any {
	value := reflect.ValueOf(job)
	if key, ok := strings.CutPrefix(apiName, "followup."); ok {
		value, apiName = value.FieldByName("Followup"), key
	}
	return value.FieldByNameFunc(func(goName string) bool { return apiFieldName(goName) == apiName }).Interface()
}

// Property: whatever an agent patch names, every field the owner last wrote holds the same value
// afterwards; a refusal names only owner-written fields; and the owner's patch is never refused.
func TestAgentPatchNeverChangesOwnerWrittenFields(t *testing.T) {
	ownable := ownableJobFields()
	rapid.Check(t, func(t *rapid.T) {
		job := drawJob(t)
		job.Writers = domain.FieldWriters{}
		for _, name := range ownable {
			if rapid.Bool().Draw(t, "owner:"+name) {
				job.Writers[name] = domain.WriterOwner
			}
		}
		var patch domain.JobPatch
		for _, field := range patchableJobFields {
			switch rapid.IntRange(0, 2).Draw(t, field.name) {
			case 1:
				field.fill(t, &patch, false)
			case 2:
				if field.name != "Company" && field.name != "Title" && field.name != "Status" {
					field.fill(t, &patch, true)
				}
			}
		}
		result, err := domain.ApplyJobPatch(job, patch, domain.WriterAgent, patchedAt)
		if err != nil {
			var refused *domain.OwnerFieldsError
			if !errors.As(err, &refused) {
				t.Fatalf("unexpected error %v", err)
			}
			for _, name := range refused.Fields {
				if job.Writers[name] != domain.WriterOwner {
					t.Fatalf("refused %q, which the owner didn't write", name)
				}
			}
			if _, err := domain.ApplyJobPatch(job, patch, domain.WriterOwner, patchedAt); err != nil {
				t.Fatalf("the same patch from the owner was refused: %v", err)
			}
			return
		}
		for name, writer := range job.Writers {
			if writer != domain.WriterOwner {
				continue
			}
			before, after := jobFieldValue(job, name), jobFieldValue(result.Record, name)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("agent patch changed owner-written %s: %#v → %#v", name, before, after)
			}
			if result.Record.Writers[name] != domain.WriterOwner {
				t.Fatalf("owner-written %s lost its writer", name)
			}
		}
		for _, name := range result.Changed {
			if !reflect.DeepEqual(jobFieldValue(result.Before, name), jobFieldValue(job, name)) {
				t.Fatalf("Before.%s isn't the prior value", name)
			}
		}
	})
}

func TestEveryOwnableNameReadsAField(t *testing.T) {
	job := newTestJob(t)
	for _, name := range ownableJobFields() {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Errorf("%s doesn't name a Job field: %v", name, recovered)
				}
			}()
			_ = jobFieldValue(job, name)
		}()
	}
}
