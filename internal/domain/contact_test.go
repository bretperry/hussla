// Tests for contacts: upsert by name keeps position, and the emailStatus spellings.

package domain_test

import (
	"testing"

	"github.com/bretperry/hussla/internal/domain"
)

func TestUpsertContactReplacesInPlace(t *testing.T) {
	contacts := []domain.Contact{{Name: "Jane Doe", Priority: "Primary"}, {Name: "Sam Lee", Priority: "Backup"}}
	updated, err := domain.UpsertContact(contacts, domain.Contact{Name: "jane doe ", Priority: "Primary", Email: "jane@example.com", EmailStatus: domain.EmailCheckVerified})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != 2 || updated[0].Email != "jane@example.com" {
		t.Fatalf("updated = %+v, want Jane replaced first in the list", updated)
	}
	if contacts[0].Email != "" {
		t.Fatal("UpsertContact mutated its input")
	}
	added, _ := domain.UpsertContact(contacts, domain.Contact{Name: "Ari Kim"})
	if len(added) != 3 || added[2].Name != "Ari Kim" {
		t.Fatalf("added = %+v", added)
	}
	if _, err := domain.UpsertContact(contacts, domain.Contact{Role: "Recruiter"}); err == nil {
		t.Fatal("a contact with no name: want an error")
	}
}

func TestEmailCheckSpellings(t *testing.T) {
	for _, name := range domain.EmailCheckNames() {
		check, err := domain.ParseEmailCheck(name)
		if err != nil || check.String() != name {
			t.Errorf("%q round-trips to %v (%v)", name, check, err)
		}
	}
	if _, err := domain.ParseEmailCheck("guessed"); err == nil {
		t.Error(`ParseEmailCheck("guessed"): want an error`)
	}
}
