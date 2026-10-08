// Tests for activity events: required action, actor naming, and cutting over-long text on a character boundary.

package domain_test

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/bretperry/hussla/internal/domain"
)

func TestNewEvent(t *testing.T) {
	if _, err := domain.NewEvent("", "Owner", "  ", "", createdAt); err == nil {
		t.Fatal("an event with no action: want an error")
	}
	event, err := domain.NewEvent("job-1", "", "Ran search", strings.Repeat("é", domain.MaxEventDetailLength), createdAt)
	if err != nil {
		t.Fatal(err)
	}
	if event.Actor != domain.ActorSystem {
		t.Errorf("actor = %q, want %q for a blank actor", event.Actor, domain.ActorSystem)
	}
	if len(event.Detail) > domain.MaxEventDetailLength || !utf8.ValidString(event.Detail) {
		t.Errorf("detail is %d bytes, valid UTF-8 = %v", len(event.Detail), utf8.ValidString(event.Detail))
	}
}

func TestActors(t *testing.T) {
	actor := domain.AgentActor("laptop-search")
	if actor != "agent:laptop-search" || !domain.IsAgentActor(actor) || domain.IsAgentActor("Owner") {
		t.Fatalf("agent actor = %q", actor)
	}
	detail := domain.StatusChangeDetail(domain.JobStatusChange{Changed: true, From: domain.JobStatusReview, To: domain.JobStatusApplied})
	if detail != "review → applied" {
		t.Fatalf("status detail = %q", detail)
	}
}
