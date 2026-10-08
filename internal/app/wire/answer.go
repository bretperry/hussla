// Answers as JSON: the object a saved answer is read from.
// In the app: the seed file's answers; (Phase 3) POST/PATCH /api/answers.
// Used by: the seed import; the HTTP layer (Phase 3).
// Uses: decode.go (the three-state field readers).

package wire

import "github.com/bretperry/hussla/internal/domain"

// DecodeAnswerPatch reads an answer write. Read-only keys (id, createdAt, answeredAt, writers) are not part of the patch.
func (decoder *Decoder) DecodeAnswerPatch(object Object) (domain.AnswerPatch, error) {
	var patch domain.AnswerPatch
	var errs [3]error
	patch.Question, errs[0] = textField(decoder, object, "question")
	patch.Answer, errs[1] = textField(decoder, object, "answer")
	patch.JobIDs, errs[2] = textsField(decoder, object, "jobIds")
	if err := firstError(errs[:]...); err != nil {
		return domain.AnswerPatch{}, err
	}
	return patch, nil
}

// DecodeAnswer reads a stored or seeded answer leniently, like DecodeJob. Writers are the caller's to set.
func DecodeAnswer(object Object) (domain.Answer, []string) {
	decoder := &Decoder{Lenient: true}
	patch, _ := decoder.DecodeAnswerPatch(object) // lenient: never fails
	answer := domain.Answer{
		Question: patch.Question.Apply(""), Answer: patch.Answer.Apply(""), JobIDs: patch.JobIDs.Apply(nil),
	}
	answer.ID = readText(decoder, object, "id")
	answer.CreatedAt = readMoment(decoder, object, "createdAt")
	answer.AnsweredAt = readMoment(decoder, object, "answeredAt")
	return answer, decoder.Warnings()
}
