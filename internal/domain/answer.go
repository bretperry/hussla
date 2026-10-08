// Saved answers: Bret's replies to application-form questions, so agents reuse them instead of guessing.
// In the app: the Answers page (unanswered first) and every agent filling a form (GET /api/answers).
// Used by: the answers use-cases and storage (Phases 2-3).
//
// An agent that meets a question with no saved answer posts the question with no answer and
// moves on; an empty answer is how the page knows what Bret still has to fill in.

package domain

import (
	"slices"
	"strings"
	"time"
)

// MaxAnswerIDLength keeps an answer id short enough to read in a URL; the question itself is unbounded.
const MaxAnswerIDLength = 60

// Answer is one form question and Bret's reply. AnsweredAt is zero while the answer is empty.
type Answer struct {
	ID         string
	Question   string
	Answer     string
	JobIDs     []string // the jobs whose forms asked it
	CreatedAt  time.Time
	AnsweredAt time.Time
}

// IsUnanswered is true while Bret hasn't written a reply.
func (answer Answer) IsUnanswered() bool { return strings.TrimSpace(answer.Answer) == "" }

// AnswerPatch names the answer fields one write speaks for.
type AnswerPatch struct {
	Question Field[string]
	Answer   Field[string]
	JobIDs   Field[[]string]
}

// AnswerIDFor is the id a new question gets: its slug, cut to MaxAnswerIDLength. ok is false
// when the question has no usable character; the caller picks an id then.
func AnswerIDFor(question string) (id string, ok bool) {
	id = Slugify(question)
	if len(id) > MaxAnswerIDLength {
		id = strings.TrimRight(id[:MaxAnswerIDLength], "-")
	}
	return id, id != ""
}

// NewAnswer records a question (and maybe its answer). The question is required.
func NewAnswer(id string, patch AnswerPatch, now time.Time) (Answer, error) {
	if !IsValidRecordID(id) {
		return Answer{}, invalid("id", "must be 1-120 lowercase letters, digits and hyphens")
	}
	if !patch.Question.IsSet() {
		return Answer{}, invalid("question", "is required")
	}
	return ApplyAnswerPatch(Answer{ID: id, CreatedAt: now.UTC()}, patch, now)
}

// ApplyAnswerPatch writes a patch onto a stored answer. AnsweredAt moves to now when the answer
// text changes to something non-empty, and clears when the answer is emptied.
func ApplyAnswerPatch(current Answer, patch AnswerPatch, now time.Time) (Answer, error) {
	if patch.Question.IsCleared() || (patch.Question.IsSet() && strings.TrimSpace(patch.Question.Value()) == "") {
		return Answer{}, invalid("question", "can't be empty")
	}
	next := current
	next.Question = trimmed(patch.Question).Apply(current.Question)
	next.Answer = patch.Answer.Apply(current.Answer)
	next.JobIDs = slices.Clone(patch.JobIDs.Apply(current.JobIDs))
	switch {
	case next.IsUnanswered():
		next.AnsweredAt = time.Time{}
	case next.Answer != current.Answer || current.AnsweredAt.IsZero():
		next.AnsweredAt = now.UTC()
	}
	return next, nil
}
