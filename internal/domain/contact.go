// Contacts: the people (and company main lines) an agent found for a job, and how sure it is of each address.
// In the app: the job page's contact cards, the company page's contact list, and the email editor's inferred-address warning.
// Used by: job.go (Job.Contacts), the contacts use-case (POST /api/jobs/:id/contacts, Phase 3).

package domain

import "strings"

// EmailCheck is how an agent knows a contact's address: seen on a real page, or guessed from the company's pattern.
type EmailCheck int

const (
	EmailCheckUnknown EmailCheck = iota
	EmailCheckVerified
	EmailCheckInferred
	EmailCheckNotFound
)

// emailCheckNames is each EmailCheck's API spelling ("not found" with a space: the prototype's).
var emailCheckNames = []string{"", "verified", "inferred", "not found"}

func (check EmailCheck) String() string { return enumName(emailCheckNames, check) }

// ParseEmailCheck reads an API spelling; "" is EmailCheckUnknown.
func ParseEmailCheck(text string) (EmailCheck, error) {
	check, ok := parseEnum[EmailCheck](emailCheckNames, text)
	if !ok {
		return EmailCheckUnknown, invalid("emailStatus", `must be "verified", "inferred", "not found" or empty`)
	}
	return check, nil
}

// EmailCheckNames lists every API spelling, for the contract and error messages.
func EmailCheckNames() []string { return append([]string(nil), emailCheckNames...) }

// Contact is one person or line to reach about a job. Free text except EmailStatus; Priority is
// the agent's ranking ("Primary", "Backup", "Company").
type Contact struct {
	Priority    string
	Name        string
	Role        string
	Email       string
	EmailStatus EmailCheck
	Phone       string
	LinkedIn    string
	Source      string
	Notes       string
}

// Validate checks the one thing a contact must have: a name to match it by.
func (contact Contact) Validate() error {
	if strings.TrimSpace(contact.Name) == "" {
		return invalid("name", "is required")
	}
	return nil
}

// sameContactName matches contacts by name, ignoring case and surrounding space, so "Jane Doe"
// and "jane doe " are one person when two agents save her.
func sameContactName(left, right string) bool {
	return strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right))
}

// UpsertContact saves one contact into a list: it replaces the contact with the same name where it
// stands (so the primary contact stays first), or appends a new one. The input list is not mutated.
func UpsertContact(contacts []Contact, contact Contact) ([]Contact, error) {
	if err := contact.Validate(); err != nil {
		return nil, err
	}
	updated := append([]Contact(nil), contacts...)
	for index := range updated {
		if sameContactName(updated[index].Name, contact.Name) {
			updated[index] = contact
			return updated, nil
		}
	}
	return append(updated, contact), nil
}
