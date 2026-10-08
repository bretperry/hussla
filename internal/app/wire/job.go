// Jobs as JSON: the API-named object for a job, and the patch an object makes.
// In the app: GET/PATCH /api/jobs, the backup bundle's jobs, and every stored job row's `data` cell.
// Used by: the SQLite adapter, the seed import, the HTTP layer (Phase 3).
// Uses: decode.go (the three-state field readers), nested.go (contacts, follow-up).

package wire

import (
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

// JobObject is a job as the API sends it: every named field, extras beside them. Writers are not
// in it (the API adds them as a read-only key; storage keeps them in their own cell).
func JobObject(job domain.Job) Object {
	object := marshalAll(map[string]any{
		"id": job.ID, "companySlug": job.CompanySlug,
		"createdAt": momentText(job.CreatedAt), "updatedAt": momentText(job.UpdatedAt),
		"company": job.Company, "title": job.Title, "status": job.Status.String(), "statusNote": job.StatusNote,
		"score": job.Score, "url": job.URL, "location": job.Location, "workType": job.WorkType.String(),
		"salaryMin": job.SalaryMin, "salaryMax": job.SalaryMax, "payText": job.PayText,
		"compensation": job.Compensation, "source": job.Source, "resume": job.Resume, "resumeSent": job.ResumeSent,
		"foundAt": momentText(job.FoundAt), "appliedAt": momentText(job.AppliedAt),
		"nextAction": job.NextAction, "nextActionDue": job.NextActionDue, "headsUp": job.HeadsUp,
		"description": job.Description, "descriptionFetchedAt": momentText(job.DescriptionFetchedAt),
		"postingStatus": job.PostingStatus.String(), "whyScore": job.WhyScore,
		"reasons": listOrNull(job.Reasons), "scamFlags": listOrNull(job.ScamFlags),
		"contacts": listOrNull(contactsToJSON(job.Contacts)), "bestChannel": job.BestChannel,
		"followup": followupToJSON(job.Followup), "companyNotes": job.CompanyNotes, "roleNotes": job.RoleNotes,
		"sources": listOrNull(job.Sources), "notes": job.Notes,
	})
	addExtras(object, job.Extras)
	return object
}

// DecodeJobPatch reads a job write. Read-only keys (id, companySlug, createdAt, updatedAt, writers)
// and the PATCH-only `note` are not part of the patch; any other unknown key becomes an extra.
func (decoder *Decoder) DecodeJobPatch(object Object) (domain.JobPatch, error) {
	var patch domain.JobPatch
	var errs [34]error
	patch.Company, errs[0] = textField(decoder, object, "company")
	patch.Title, errs[1] = textField(decoder, object, "title")
	patch.Status, errs[2] = enumField(decoder, object, "status", domain.ParseJobStatus)
	patch.StatusNote, errs[3] = textField(decoder, object, "statusNote")
	patch.Score, errs[4] = wholeField(decoder, object, "score")
	patch.URL, errs[5] = textField(decoder, object, "url")
	patch.Location, errs[6] = textField(decoder, object, "location")
	patch.WorkType, errs[7] = enumField(decoder, object, "workType", domain.ParseWorkType)
	patch.SalaryMin, errs[8] = wholeField(decoder, object, "salaryMin")
	patch.SalaryMax, errs[9] = wholeField(decoder, object, "salaryMax")
	patch.PayText, errs[10] = textField(decoder, object, "payText")
	patch.Compensation, errs[11] = textField(decoder, object, "compensation")
	patch.Source, errs[12] = textField(decoder, object, "source")
	patch.Resume, errs[13] = textField(decoder, object, "resume")
	patch.ResumeSent, errs[14] = textField(decoder, object, "resumeSent")
	patch.FoundAt, errs[15] = momentField(decoder, object, "foundAt")
	patch.AppliedAt, errs[16] = momentField(decoder, object, "appliedAt")
	patch.NextAction, errs[17] = textField(decoder, object, "nextAction")
	patch.NextActionDue, errs[18] = textField(decoder, object, "nextActionDue")
	patch.HeadsUp, errs[19] = textField(decoder, object, "headsUp")
	patch.Description, errs[20] = textField(decoder, object, "description")
	patch.DescriptionFetchedAt, errs[21] = momentField(decoder, object, "descriptionFetchedAt")
	patch.PostingStatus, errs[22] = enumField(decoder, object, "postingStatus", domain.ParsePostingStatus)
	patch.WhyScore, errs[23] = textField(decoder, object, "whyScore")
	patch.Reasons, errs[24] = textsField(decoder, object, "reasons")
	patch.ScamFlags, errs[25] = textsField(decoder, object, "scamFlags")
	patch.Contacts, errs[26] = decoder.contactsField(object, "contacts")
	patch.BestChannel, errs[27] = textField(decoder, object, "bestChannel")
	patch.Followup, errs[28] = decoder.followupField(object, "followup")
	patch.CompanyNotes, errs[29] = textField(decoder, object, "companyNotes")
	patch.RoleNotes, errs[30] = textField(decoder, object, "roleNotes")
	patch.Sources, errs[31] = textsField(decoder, object, "sources")
	patch.Notes, errs[32] = textField(decoder, object, "notes")
	patch.Extras = extrasPatch(object, domain.IsJobFieldName)
	if err := firstError(errs[:]...); err != nil {
		return domain.JobPatch{}, err
	}
	return patch, nil
}

// DecodeJob reads a stored job leniently: whatever can be read is kept, the rest is a warning.
// It checks no rule (a stored job is whatever was stored); Writers are the caller's to set.
func DecodeJob(object Object) (domain.Job, []string) {
	decoder := &Decoder{Lenient: true}
	patch, _ := decoder.DecodeJobPatch(object) // lenient: never fails
	followup := domain.FollowupPatch{}
	if patch.Followup.IsSet() {
		followup = patch.Followup.Value()
	}
	job := domain.Job{
		Company: patch.Company.Apply(""), Title: patch.Title.Apply(""), Status: patch.Status.Apply(domain.JobStatusReview),
		StatusNote: patch.StatusNote.Apply(""), Score: patch.Score.Apply(nil), URL: patch.URL.Apply(""),
		Location: patch.Location.Apply(""), WorkType: patch.WorkType.Apply(domain.WorkTypeUnknown),
		SalaryMin: patch.SalaryMin.Apply(nil), SalaryMax: patch.SalaryMax.Apply(nil), PayText: patch.PayText.Apply(""),
		Compensation: patch.Compensation.Apply(""), Source: patch.Source.Apply(""), Resume: patch.Resume.Apply(""),
		ResumeSent: patch.ResumeSent.Apply(""), FoundAt: patch.FoundAt.Apply(zeroTime), AppliedAt: patch.AppliedAt.Apply(zeroTime),
		NextAction: patch.NextAction.Apply(""), NextActionDue: patch.NextActionDue.Apply(""), HeadsUp: patch.HeadsUp.Apply(""),
		Description: patch.Description.Apply(""), DescriptionFetchedAt: patch.DescriptionFetchedAt.Apply(zeroTime),
		PostingStatus: patch.PostingStatus.Apply(domain.PostingStatusUnknown), WhyScore: patch.WhyScore.Apply(""),
		Reasons: patch.Reasons.Apply(nil), ScamFlags: patch.ScamFlags.Apply(nil), Contacts: patch.Contacts.Apply(nil),
		BestChannel: patch.BestChannel.Apply(""), Followup: followup.Apply(domain.Followup{}),
		CompanyNotes: patch.CompanyNotes.Apply(""), RoleNotes: patch.RoleNotes.Apply(""), Sources: patch.Sources.Apply(nil),
		Notes: patch.Notes.Apply(""), Extras: extrasOf(patch.Extras),
	}
	job.ID = readText(decoder, object, "id")
	job.CompanySlug = readText(decoder, object, "companySlug")
	job.CreatedAt = readMoment(decoder, object, "createdAt")
	job.UpdatedAt = readMoment(decoder, object, "updatedAt")
	return job, decoder.Warnings()
}

// zeroTime is "not set" for Apply calls.
var zeroTime time.Time

// readText reads one text key of a stored object, "" when absent, null or unreadable.
func readText(decoder *Decoder, object Object, key string) string {
	field, _ := textField(decoder, object, key)
	return field.Apply("")
}

// readMoment reads one time key of a stored object, zero when absent, null or unreadable.
func readMoment(decoder *Decoder, object Object, key string) time.Time {
	field, _ := momentField(decoder, object, key)
	return field.Apply(zeroTime)
}
