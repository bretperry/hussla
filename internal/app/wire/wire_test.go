package wire_test

import (
	"errors"
	"testing"

	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

func parse(t *testing.T, text string) wire.Object {
	t.Helper()
	object, err := wire.ParseObject([]byte(text))
	if err != nil {
		t.Fatalf("parse %s: %v", text, err)
	}
	return object
}

func TestJobPatchHasThreeStates(t *testing.T) {
	var decoder wire.Decoder
	patch, err := decoder.DecodeJobPatch(parse(t, `{"title":"New","url":null,"agentTag":{"a":1},"oldTag":null}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !patch.Title.IsSet() || patch.Title.Value() != "New" {
		t.Errorf("title should be set: %+v", patch.Title)
	}
	if !patch.URL.IsCleared() {
		t.Errorf("a null url should clear it: %+v", patch.URL)
	}
	if !patch.Location.IsAbsent() {
		t.Errorf("an unnamed field stays absent: %+v", patch.Location)
	}
	if extra := patch.Extras["agentTag"]; !extra.IsSet() || extra.Value() != `{"a":1}` {
		t.Errorf("an unknown key becomes an extra: %+v", patch.Extras)
	}
	if !patch.Extras["oldTag"].IsCleared() {
		t.Errorf("a null unknown key clears the extra: %+v", patch.Extras)
	}
}

func TestStrictDecodingNamesTheBadKey(t *testing.T) {
	for _, body := range []string{`{"score":"high"}`, `{"score":72.5}`, `{"status":"hired"}`, `{"reasons":"one"}`, `{"followup":[1]}`, `{"contacts":[{"emailStatus":"maybe"}]}`} {
		var decoder wire.Decoder
		_, err := decoder.DecodeJobPatch(parse(t, body))
		var validation *domain.ValidationError
		if !errors.As(err, &validation) {
			t.Errorf("%s: want a ValidationError, got %v", body, err)
		}
	}
	var decoder wire.Decoder
	if _, err := decoder.DecodeJobPatch(parse(t, `{"score":72.0}`)); err != nil {
		t.Errorf("72.0 is a whole number agents write: %v", err)
	}
}

func TestLenientDecodingKeepsWhatItCanRead(t *testing.T) {
	object := parse(t, `{"id":"a","company":"Acme","title":"T","status":"hired","score":"x","workType":"remote",
		"contacts":[{"name":"Jane","emailStatus":"maybe"},{"name":"Sam","emailStatus":"verified"}]}`)
	job, warnings := wire.DecodeJob(object)
	if job.Status != domain.JobStatusReview || job.Score != nil || job.WorkType != domain.WorkTypeRemote {
		t.Errorf("unreadable values are skipped, readable ones kept: %+v", job)
	}
	if len(job.Contacts) != 2 || job.Contacts[0].Name != "Jane" || job.Contacts[0].EmailStatus != domain.EmailCheckUnknown ||
		job.Contacts[1].EmailStatus != domain.EmailCheckVerified {
		t.Errorf("a contact with an odd emailStatus must survive: %+v", job.Contacts)
	}
	if len(warnings) != 3 {
		t.Errorf("each skipped value is reported: %v", warnings)
	}
}

func TestWritersStoreOwnerEntriesOnly(t *testing.T) {
	encoded := wire.EncodeWriters(domain.FieldWriters{"notes": domain.WriterOwner, "title": domain.WriterAgent})
	if encoded != `{"notes":"owner"}` {
		t.Errorf("encoded = %s", encoded)
	}
	decoded, err := wire.DecodeWriters(encoded)
	if err != nil || len(decoded) != 1 || decoded["notes"] != domain.WriterOwner {
		t.Errorf("decoded = %v, %v", decoded, err)
	}
	if empty, err := wire.DecodeWriters("{}"); err != nil || empty != nil {
		t.Errorf("no owner entries decode to nil: %v, %v", empty, err)
	}
	if _, err := wire.DecodeWriters("{broken"); err == nil {
		t.Error("a damaged cell must be an error, never silently 'no owner fields'")
	}
}

func TestACompanyKeepsUnknownTopLevelKeysButNotNestedOnes(t *testing.T) {
	var decoder wire.Decoder
	patch, err := decoder.DecodeCompanyPatch(parse(t, `{"quickTake":"Q","customField":[1],"profile":{"website":"w","mystery":"dropped"}}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if patch.Extras["customField"].Value() != `[1]` {
		t.Errorf("top-level extras kept: %+v", patch.Extras)
	}
	if patch.Profile.Value().Website != "w" {
		t.Errorf("profile: %+v", patch.Profile.Value())
	}
}
