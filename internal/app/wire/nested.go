// Nested objects as JSON: contacts, follow-ups, reviews and the other shapes inside a job or company.
// In the app: the contact cards, the follow-up editor, the company page's reviews, money and news blocks.
// Used by: job.go and company.go.
//
// Nested objects are typed: a key the domain doesn't know inside one is dropped (decision 0009).
// A nested value replaces whole, except `followup`, which merges by key.

package wire

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

type contactJSON struct {
	Priority    string `json:"priority"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	Email       string `json:"email"`
	EmailStatus string `json:"emailStatus"`
	Phone       string `json:"phone"`
	LinkedIn    string `json:"linkedin"`
	Source      string `json:"source"`
	Notes       string `json:"notes"`
}

func contactsToJSON(contacts []domain.Contact) []contactJSON {
	if contacts == nil {
		return nil
	}
	encoded := make([]contactJSON, len(contacts))
	for index, contact := range contacts {
		encoded[index] = contactJSON{
			Priority: contact.Priority, Name: contact.Name, Role: contact.Role, Email: contact.Email,
			EmailStatus: contact.EmailStatus.String(), Phone: contact.Phone, LinkedIn: contact.LinkedIn,
			Source: contact.Source, Notes: contact.Notes,
		}
	}
	return encoded
}

// contactsField reads a contact list. An unknown emailStatus spelling is a problem on the whole key.
func (decoder *Decoder) contactsField(object Object, key string) (domain.Field[[]domain.Contact], error) {
	return decodeField(decoder, object, key, func(raw json.RawMessage) ([]domain.Contact, error) {
		encoded := []contactJSON{}
		if err := json.Unmarshal(raw, &encoded); err != nil {
			return nil, errors.New("must be a list of contacts")
		}
		contacts := make([]domain.Contact, len(encoded))
		for index, item := range encoded {
			emailStatus, err := domain.ParseEmailCheck(item.EmailStatus)
			if err != nil {
				return nil, err
			}
			contacts[index] = domain.Contact{
				Priority: item.Priority, Name: item.Name, Role: item.Role, Email: item.Email, EmailStatus: emailStatus,
				Phone: item.Phone, LinkedIn: item.LinkedIn, Source: item.Source, Notes: item.Notes,
			}
		}
		return contacts, nil
	})
}

type followupJSON struct {
	To             string  `json:"to"`
	Subject        string  `json:"subject"`
	Body           string  `json:"body"`
	LinkedIn       string  `json:"linkedin"`
	CallNotes      string  `json:"callNotes"`
	EmailSentAt    *string `json:"emailSentAt"`
	LinkedInSentAt *string `json:"linkedinSentAt"`
	CallMadeAt     *string `json:"callMadeAt"`
}

func followupToJSON(followup domain.Followup) followupJSON {
	return followupJSON{
		To: followup.To, Subject: followup.Subject, Body: followup.Body, LinkedIn: followup.LinkedIn,
		CallNotes: followup.CallNotes, EmailSentAt: momentText(followup.EmailSentAt),
		LinkedInSentAt: momentText(followup.LinkedInSentAt), CallMadeAt: momentText(followup.CallMadeAt),
	}
}

// followupField reads a follow-up write: an object names the keys to merge; null empties it.
func (decoder *Decoder) followupField(object Object, key string) (domain.Field[domain.FollowupPatch], error) {
	return decodeField(decoder, object, key, func(raw json.RawMessage) (domain.FollowupPatch, error) {
		inner, err := ParseObject(raw)
		if err != nil {
			return domain.FollowupPatch{}, errors.New("must be an object")
		}
		var patch domain.FollowupPatch
		var errs [8]error
		patch.To, errs[0] = textField(decoder, inner, "to")
		patch.Subject, errs[1] = textField(decoder, inner, "subject")
		patch.Body, errs[2] = textField(decoder, inner, "body")
		patch.LinkedIn, errs[3] = textField(decoder, inner, "linkedin")
		patch.CallNotes, errs[4] = textField(decoder, inner, "callNotes")
		patch.EmailSentAt, errs[5] = momentField(decoder, inner, "emailSentAt")
		patch.LinkedInSentAt, errs[6] = momentField(decoder, inner, "linkedinSentAt")
		patch.CallMadeAt, errs[7] = momentField(decoder, inner, "callMadeAt")
		return patch, firstError(errs[:]...)
	})
}

// momentOrZero reads a nested time; a value that isn't a time is an error for the caller to report.
func momentOrZero(text *string) (time.Time, error) {
	if text == nil || *text == "" {
		return time.Time{}, nil
	}
	return parseMoment(rawQuoted(*text))
}

func rawQuoted(text string) json.RawMessage {
	encoded, _ := json.Marshal(text) // text always encodes
	return encoded
}
