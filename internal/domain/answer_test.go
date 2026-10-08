// Tests for saved answers: ids from questions, and when AnsweredAt moves.

package domain_test

import (
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

func TestAnswerIDFor(t *testing.T) {
	id, ok := domain.AnswerIDFor("Are you authorized to work in the US?")
	if !ok || id != "are-you-authorized-to-work-in-the-us" {
		t.Errorf("AnswerIDFor = %q, %v", id, ok)
	}
	long, _ := domain.AnswerIDFor(strings.Repeat("why do you want to work here ", 5))
	if len(long) > domain.MaxAnswerIDLength || strings.HasSuffix(long, "-") {
		t.Errorf("long id = %q", long)
	}
}

func TestAnsweredAtFollowsTheAnswer(t *testing.T) {
	asked, err := domain.NewAnswer("salary-expectations", domain.AnswerPatch{
		Question: domain.Set("Salary expectations?"), JobIDs: domain.Set([]string{"example-co-staff-engineer"}),
	}, domain.WriterAgent, createdAt)
	if err != nil {
		t.Fatal(err)
	}
	if !asked.IsUnanswered() || !asked.AnsweredAt.IsZero() {
		t.Fatalf("a new question = %+v, want unanswered", asked)
	}
	answered := applyAnswer(t, asked, domain.AnswerPatch{Answer: domain.Set("Open to discuss")}, domain.WriterOwner, patchedAt)
	if !answered.AnsweredAt.Equal(patchedAt) {
		t.Errorf("answeredAt = %v, want %v", answered.AnsweredAt, patchedAt)
	}
	sameAgain := applyAnswer(t, answered, domain.AnswerPatch{Answer: domain.Set("Open to discuss")}, domain.WriterOwner, patchedAt.Add(time.Hour))
	if !sameAgain.AnsweredAt.Equal(patchedAt) {
		t.Errorf("re-saving the same answer moved answeredAt to %v", sameAgain.AnsweredAt)
	}
	emptied := applyAnswer(t, answered, domain.AnswerPatch{Answer: domain.Clear[string]()}, domain.WriterOwner, patchedAt)
	if !emptied.IsUnanswered() || !emptied.AnsweredAt.IsZero() {
		t.Errorf("emptied = %+v, want unanswered again", emptied)
	}
	if _, err := domain.NewAnswer("x", domain.AnswerPatch{Answer: domain.Set("yes")}, domain.WriterAgent, createdAt); err == nil {
		t.Error("an answer with no question: want an error")
	}
}

// applyAnswer runs ApplyAnswerPatch and fails the test on an error.
func applyAnswer(t *testing.T, answer domain.Answer, patch domain.AnswerPatch, writer domain.Writer, now time.Time) domain.Answer {
	t.Helper()
	result, err := domain.ApplyAnswerPatch(answer, patch, writer, now)
	if err != nil {
		t.Fatal(err)
	}
	return result.Record
}
