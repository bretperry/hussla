// Jobs: one posting Bret might apply to, everything agents found about it, and the patch rule that writes it.
// In the app: the jobs table, the job page, and every agent write (POST/PUT/PATCH /api/jobs) go through NewJob and ApplyJobPatch.
// Used by: the jobs use-cases and storage (Phases 2-3), company.go (summaries read jobs).
// Uses: config.JobStatusOrder (the status ids), patch.go (Field), contact.go.
//
// Patch rule (the prototype's, kept): a field the patch doesn't name is left alone; a named field
// replaces the stored one whole (lists and objects too); null clears it. The one exception is
// `followup`, which merges key by key, because a follow-up is filled in by different agents at
// different times (one drafts the email, another logs the call) and none should erase the other.

package domain

import (
	"slices"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/config"
)

// JobStatus is where a job stands in the pipeline. Members follow config.JobStatusOrder one to one.
type JobStatus int

const (
	JobStatusReview JobStatus = iota
	JobStatusQueued
	JobStatusWaiting
	JobStatusApplied
	JobStatusScreening
	JobStatusInterviewing
	JobStatusOffer
	JobStatusRejected
	JobStatusWithdrawn
	JobStatusSkipped
	JobStatusFiltered
	JobStatusFailed
)

func (status JobStatus) String() string { return enumName(config.JobStatusOrder, status) }

// ParseJobStatus reads a status id; the error lists every valid one, so an agent can correct itself.
func ParseJobStatus(text string) (JobStatus, error) {
	status, ok := parseEnum[JobStatus](config.JobStatusOrder, text)
	if !ok {
		return JobStatusReview, invalid("status", `unknown status "`+text+`"; use one of: `+strings.Join(config.JobStatusOrder, ", "))
	}
	return status, nil
}

// WorkType is where the work happens. Unknown is the empty spelling: many postings don't say.
type WorkType int

const (
	WorkTypeUnknown WorkType = iota
	WorkTypeRemote
	WorkTypeHybrid
	WorkTypeOnsite
)

var workTypeNames = []string{"", "remote", "hybrid", "onsite"}

func (workType WorkType) String() string { return enumName(workTypeNames, workType) }

// ParseWorkType reads an API spelling; "" is WorkTypeUnknown.
func ParseWorkType(text string) (WorkType, error) {
	workType, ok := parseEnum[WorkType](workTypeNames, text)
	if !ok {
		return WorkTypeUnknown, invalid("workType", `must be "remote", "hybrid", "onsite" or empty`)
	}
	return workType, nil
}

// WorkTypeNames lists every API spelling, for the contract.
func WorkTypeNames() []string { return append([]string(nil), workTypeNames...) }

// PostingStatus is whether the posting was still up when an agent last looked.
type PostingStatus int

const (
	PostingStatusUnknown PostingStatus = iota
	PostingStatusOpen
	PostingStatusClosed
)

// postingStatusNames: "unknown" is spelled out (the prototype's agents send it); "" also parses as unknown.
var postingStatusNames = []string{"unknown", "open", "closed"}

func (postingStatus PostingStatus) String() string {
	return enumName(postingStatusNames, postingStatus)
}

// ParsePostingStatus reads an API spelling; "" and "unknown" are PostingStatusUnknown.
func ParsePostingStatus(text string) (PostingStatus, error) {
	if text == "" {
		return PostingStatusUnknown, nil
	}
	postingStatus, ok := parseEnum[PostingStatus](postingStatusNames, text)
	if !ok {
		return PostingStatusUnknown, invalid("postingStatus", `must be "open", "closed" or "unknown"`)
	}
	return postingStatus, nil
}

// MinScore and MaxScore bound a job's fit score.
const (
	MinScore = 0
	MaxScore = 100
)

// Followup is the outreach plan for a job: the drafted email, LinkedIn note and call notes, and when each went out.
type Followup struct {
	To             string
	Subject        string
	Body           string
	LinkedIn       string
	CallNotes      string
	EmailSentAt    time.Time
	LinkedInSentAt time.Time
	CallMadeAt     time.Time
}

// FollowupPatch names the follow-up keys to change; the rest of the stored follow-up stays.
type FollowupPatch struct {
	To             Field[string]
	Subject        Field[string]
	Body           Field[string]
	LinkedIn       Field[string]
	CallNotes      Field[string]
	EmailSentAt    Field[time.Time]
	LinkedInSentAt Field[time.Time]
	CallMadeAt     Field[time.Time]
}

// Apply merges the named keys into a stored follow-up.
func (patch FollowupPatch) Apply(current Followup) Followup {
	return Followup{
		To:             patch.To.Apply(current.To),
		Subject:        patch.Subject.Apply(current.Subject),
		Body:           patch.Body.Apply(current.Body),
		LinkedIn:       patch.LinkedIn.Apply(current.LinkedIn),
		CallNotes:      patch.CallNotes.Apply(current.CallNotes),
		EmailSentAt:    patch.EmailSentAt.Apply(current.EmailSentAt),
		LinkedInSentAt: patch.LinkedInSentAt.Apply(current.LinkedInSentAt),
		CallMadeAt:     patch.CallMadeAt.Apply(current.CallMadeAt),
	}
}

// Job is one posting and everything known about it. A zero time.Time means "not set"; numbers
// that may be unknown (score, pay) are pointers.
type Job struct {
	ID          string
	CompanySlug string // derived from Company on every write; never patched directly
	CreatedAt   time.Time
	UpdatedAt   time.Time

	Company       string
	Title         string
	Status        JobStatus
	StatusNote    string
	Score         *int
	URL           string
	Location      string
	WorkType      WorkType
	SalaryMin     *int
	SalaryMax     *int
	PayText       string
	Compensation  string // the posting's full pay text
	Source        string // where the job was found ("Greenhouse")
	Resume        string // résumé variant planned
	ResumeSent    string // file actually submitted
	FoundAt       time.Time
	AppliedAt     time.Time
	NextAction    string
	NextActionDue string // free text or a date; agents write both
	HeadsUp       string
	Description   string // markdown

	DescriptionFetchedAt time.Time
	PostingStatus        PostingStatus
	WhyScore             string
	Reasons              []string
	ScamFlags            []string
	Contacts             []Contact
	BestChannel          string // markdown
	Followup             Followup
	CompanyNotes         string // markdown
	RoleNotes            string // markdown
	Sources              []string
	Notes                string // Bret's own; agents don't overwrite (enforced in the HTTP layer)

	Extras Extras
}

// JobPatch names the job fields one write speaks for. The zero JobPatch changes nothing.
// Followup is the exception to "set replaces": a set Followup merges key by key; a cleared one empties it.
type JobPatch struct {
	Company       Field[string]
	Title         Field[string]
	Status        Field[JobStatus]
	StatusNote    Field[string]
	Score         Field[*int]
	URL           Field[string]
	Location      Field[string]
	WorkType      Field[WorkType]
	SalaryMin     Field[*int]
	SalaryMax     Field[*int]
	PayText       Field[string]
	Compensation  Field[string]
	Source        Field[string]
	Resume        Field[string]
	ResumeSent    Field[string]
	FoundAt       Field[time.Time]
	AppliedAt     Field[time.Time]
	NextAction    Field[string]
	NextActionDue Field[string]
	HeadsUp       Field[string]
	Description   Field[string]

	DescriptionFetchedAt Field[time.Time]
	PostingStatus        Field[PostingStatus]
	WhyScore             Field[string]
	Reasons              Field[[]string]
	ScamFlags            Field[[]string]
	Contacts             Field[[]Contact]
	BestChannel          Field[string]
	Followup             Field[FollowupPatch]
	CompanyNotes         Field[string]
	RoleNotes            Field[string]
	Sources              Field[[]string]
	Notes                Field[string]

	Extras ExtrasPatch
}

// jobFieldNames is every job key the API knows by name, read-only ones and the PATCH-only
// "note" included, so none of them can be stored again as an extra.
var jobFieldNames = map[string]bool{
	"id": true, "companySlug": true, "createdAt": true, "updatedAt": true, "note": true,
	"company": true, "title": true, "status": true, "statusNote": true, "score": true, "url": true,
	"location": true, "workType": true, "salaryMin": true, "salaryMax": true, "payText": true,
	"compensation": true, "source": true, "resume": true, "resumeSent": true, "foundAt": true,
	"appliedAt": true, "nextAction": true, "nextActionDue": true, "headsUp": true, "description": true,
	"descriptionFetchedAt": true, "postingStatus": true, "whyScore": true, "reasons": true,
	"scamFlags": true, "contacts": true, "bestChannel": true, "followup": true, "companyNotes": true,
	"roleNotes": true, "sources": true, "notes": true,
}

// IsJobFieldName reports whether a JSON key is one of the job's named fields (so not an extra).
func IsJobFieldName(key string) bool { return jobFieldNames[key] }

// JobStatusChange is the status move a write made, for the activity log ("review → applied").
// Changed is false when the status stayed (or the job is new: creating isn't a move).
type JobStatusChange struct {
	Changed bool
	From    JobStatus
	To      JobStatus
}

// JobIDFor is the id a new job gets from its company and title ("Acme" + "Staff Engineer" →
// "acme-staff-engineer"). ok is false when neither has a usable character; the caller picks an id then.
func JobIDFor(company, title string) (id string, ok bool) {
	id = Slugify(company + " " + title)
	return id, id != ""
}

// IsValidRecordID accepts ids that are safe in a URL path and a file name: 1-MaxSlugLength
// lowercase letters, digits and hyphens. Slugs and UUIDs both fit.
func IsValidRecordID(id string) bool {
	if id == "" || len(id) > MaxSlugLength {
		return false
	}
	for _, character := range id {
		isLetterOrDigit := (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
		if !isLetterOrDigit && character != '-' {
			return false
		}
	}
	return true
}

// NewJob creates a job from its first write. Company and title are required; status defaults to
// review. Moving straight to applied stamps AppliedAt, the same as a later move would.
func NewJob(id string, patch JobPatch, now time.Time) (Job, error) {
	if !IsValidRecordID(id) {
		return Job{}, invalid("id", "must be 1-120 lowercase letters, digits and hyphens")
	}
	if !patch.Company.IsSet() || strings.TrimSpace(patch.Company.Value()) == "" {
		return Job{}, invalid("company", "is required")
	}
	if !patch.Title.IsSet() || strings.TrimSpace(patch.Title.Value()) == "" {
		return Job{}, invalid("title", "is required")
	}
	defaultStatus, err := ParseJobStatus(config.NewJobStatus)
	if err != nil {
		return Job{}, err
	}
	now = now.UTC()
	draft := Job{ID: id, CreatedAt: now, Status: defaultStatus}
	job, _, err := applyJobPatch(draft, patch, now, true)
	return job, err
}

// ApplyJobPatch writes a patch onto a stored job and says whether the status moved. A move into
// applied stamps AppliedAt with `now` unless the job already has one or the patch names appliedAt.
func ApplyJobPatch(current Job, patch JobPatch, now time.Time) (Job, JobStatusChange, error) {
	return applyJobPatch(current, patch, now.UTC(), false)
}

func applyJobPatch(current Job, patch JobPatch, now time.Time, creating bool) (Job, JobStatusChange, error) {
	if err := validateJobPatch(current, patch); err != nil {
		return Job{}, JobStatusChange{}, err
	}
	next := current
	next.Company = trimmed(patch.Company).Apply(current.Company)
	next.Title = trimmed(patch.Title).Apply(current.Title)
	next.Status = patch.Status.Apply(current.Status)
	next.StatusNote = patch.StatusNote.Apply(current.StatusNote)
	next.Score = copyInt(patch.Score.Apply(current.Score))
	next.URL = patch.URL.Apply(current.URL)
	next.Location = patch.Location.Apply(current.Location)
	next.WorkType = patch.WorkType.Apply(current.WorkType)
	next.SalaryMin = copyInt(patch.SalaryMin.Apply(current.SalaryMin))
	next.SalaryMax = copyInt(patch.SalaryMax.Apply(current.SalaryMax))
	next.PayText = patch.PayText.Apply(current.PayText)
	next.Compensation = patch.Compensation.Apply(current.Compensation)
	next.Source = patch.Source.Apply(current.Source)
	next.Resume = patch.Resume.Apply(current.Resume)
	next.ResumeSent = patch.ResumeSent.Apply(current.ResumeSent)
	next.FoundAt = patch.FoundAt.Apply(current.FoundAt)
	next.AppliedAt = patch.AppliedAt.Apply(current.AppliedAt)
	next.NextAction = patch.NextAction.Apply(current.NextAction)
	next.NextActionDue = patch.NextActionDue.Apply(current.NextActionDue)
	next.HeadsUp = patch.HeadsUp.Apply(current.HeadsUp)
	next.Description = patch.Description.Apply(current.Description)
	next.DescriptionFetchedAt = patch.DescriptionFetchedAt.Apply(current.DescriptionFetchedAt)
	next.PostingStatus = patch.PostingStatus.Apply(current.PostingStatus)
	next.WhyScore = patch.WhyScore.Apply(current.WhyScore)
	next.Reasons = slices.Clone(patch.Reasons.Apply(current.Reasons))
	next.ScamFlags = slices.Clone(patch.ScamFlags.Apply(current.ScamFlags))
	next.Contacts = slices.Clone(patch.Contacts.Apply(current.Contacts))
	next.BestChannel = patch.BestChannel.Apply(current.BestChannel)
	next.Followup = applyFollowup(current.Followup, patch.Followup)
	next.CompanyNotes = patch.CompanyNotes.Apply(current.CompanyNotes)
	next.RoleNotes = patch.RoleNotes.Apply(current.RoleNotes)
	next.Sources = slices.Clone(patch.Sources.Apply(current.Sources))
	next.Notes = patch.Notes.Apply(current.Notes)
	next.Extras = applyExtras(current.Extras, patch.Extras)

	next.CompanySlug = Slugify(next.Company)
	if creating || !patch.isEmpty() {
		next.UpdatedAt = now
	}

	change := JobStatusChange{From: current.Status, To: next.Status, Changed: !creating && current.Status != next.Status}
	movedIntoApplied := next.Status == JobStatusApplied && (creating || current.Status != JobStatusApplied)
	// A patch that names appliedAt itself (even as null) has said what it should be; don't overrule it.
	if movedIntoApplied && patch.AppliedAt.IsAbsent() && next.AppliedAt.IsZero() {
		next.AppliedAt = now
	}
	return next, change, nil
}

// applyFollowup merges a set follow-up key by key, empties a cleared one, and leaves an absent one.
func applyFollowup(current Followup, field Field[FollowupPatch]) Followup {
	switch {
	case field.IsSet():
		return field.Value().Apply(current)
	case field.IsCleared():
		return Followup{}
	default:
		return current
	}
}

// validateJobPatch refuses a patch that would leave the job without a company, title or status,
// or with a value outside its range. Nothing is written when it fails.
func validateJobPatch(current Job, patch JobPatch) error {
	if patch.Company.IsCleared() || (patch.Company.IsSet() && strings.TrimSpace(patch.Company.Value()) == "") {
		return invalid("company", "can't be empty")
	}
	if patch.Title.IsCleared() || (patch.Title.IsSet() && strings.TrimSpace(patch.Title.Value()) == "") {
		return invalid("title", "can't be empty")
	}
	if patch.Status.IsCleared() {
		return invalid("status", "can't be cleared; set another status")
	}
	if score := patch.Score.Value(); patch.Score.IsSet() && score != nil && (*score < MinScore || *score > MaxScore) {
		return invalid("score", "must be between 0 and 100")
	}
	for _, salary := range []struct {
		name  string
		field Field[*int]
	}{{"salaryMin", patch.SalaryMin}, {"salaryMax", patch.SalaryMax}} {
		if value := salary.field.Value(); salary.field.IsSet() && value != nil && *value < 0 {
			return invalid(salary.name, "can't be negative")
		}
	}
	if patch.Contacts.IsSet() {
		for _, contact := range patch.Contacts.Value() {
			if err := contact.Validate(); err != nil {
				return invalid("contacts", "every contact needs a name")
			}
		}
	}
	return validateExtrasPatch(current.Extras, patch.Extras, jobFieldNames)
}

// isEmpty is true when the patch names no field at all.
func (patch JobPatch) isEmpty() bool {
	named := []bool{
		patch.Company.IsAbsent(), patch.Title.IsAbsent(), patch.Status.IsAbsent(), patch.StatusNote.IsAbsent(),
		patch.Score.IsAbsent(), patch.URL.IsAbsent(), patch.Location.IsAbsent(), patch.WorkType.IsAbsent(),
		patch.SalaryMin.IsAbsent(), patch.SalaryMax.IsAbsent(), patch.PayText.IsAbsent(), patch.Compensation.IsAbsent(),
		patch.Source.IsAbsent(), patch.Resume.IsAbsent(), patch.ResumeSent.IsAbsent(), patch.FoundAt.IsAbsent(),
		patch.AppliedAt.IsAbsent(), patch.NextAction.IsAbsent(), patch.NextActionDue.IsAbsent(), patch.HeadsUp.IsAbsent(),
		patch.Description.IsAbsent(), patch.DescriptionFetchedAt.IsAbsent(), patch.PostingStatus.IsAbsent(),
		patch.WhyScore.IsAbsent(), patch.Reasons.IsAbsent(), patch.ScamFlags.IsAbsent(), patch.Contacts.IsAbsent(),
		patch.BestChannel.IsAbsent(), patch.Followup.IsAbsent(), patch.CompanyNotes.IsAbsent(), patch.RoleNotes.IsAbsent(),
		patch.Sources.IsAbsent(), patch.Notes.IsAbsent(), len(patch.Extras) == 0,
	}
	for _, absent := range named {
		if !absent {
			return false
		}
	}
	return true
}

// copyInt detaches a stored number from the patch that supplied it, so a caller who keeps
// mutating its patch can't reach into a stored job. Lists are detached with slices.Clone, which
// also keeps an empty list empty rather than turning it into "none".
func copyInt(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
