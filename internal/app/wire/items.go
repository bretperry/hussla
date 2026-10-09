// Single nested items as JSON: one contact, one news item, one review, one answer, for the routes that add one at a time.
// In the app: POST /api/jobs/:id/contacts, /api/companies/:slug/news and /reviews; answers in API responses and exports.
// Used by: the HTTP layer and the record use-cases (tracker); export bundles.
// Uses: the list readers in nested.go and company.go, so one item reads exactly like an item in a list.

package wire

import (
	"encoding/json"
	"fmt"

	"github.com/bretperry/hussla/internal/domain"
)

// asList wraps one JSON value as a one-item list, to reuse the list readers.
func asList(raw json.RawMessage) json.RawMessage {
	return json.RawMessage(fmt.Sprintf("[%s]", raw))
}

// isObject is true for a JSON object (the only shape a single item may have).
func isObject(raw json.RawMessage) bool {
	object, err := ParseObject(raw)
	return err == nil && object != nil
}

// DecodeContact reads one contact strictly.
func DecodeContact(raw json.RawMessage) (domain.Contact, error) {
	if !isObject(raw) {
		return domain.Contact{}, &domain.ValidationError{Field: "(body)", Problem: "must be a contact object"}
	}
	decoder := &Decoder{}
	field, err := decoder.contactsField(Object{"contact": asList(raw)}, "contact")
	if err != nil {
		return domain.Contact{}, err
	}
	return field.Value()[0], nil
}

// DecodeNewsItem reads one news item strictly.
func DecodeNewsItem(raw json.RawMessage) (domain.NewsItem, error) {
	if !isObject(raw) {
		return domain.NewsItem{}, &domain.ValidationError{Field: "(body)", Problem: "must be a news object"}
	}
	news, err := parseNews(asList(raw))
	if err != nil {
		return domain.NewsItem{}, &domain.ValidationError{Field: "(body)", Problem: err.Error()}
	}
	return news[0], nil
}

// DecodeReview reads one review strictly.
func DecodeReview(raw json.RawMessage) (domain.Review, error) {
	if !isObject(raw) {
		return domain.Review{}, &domain.ValidationError{Field: "(body)", Problem: "must be a review object"}
	}
	reviews, err := parseReviews(asList(raw))
	if err != nil {
		return domain.Review{}, &domain.ValidationError{Field: "(body)", Problem: err.Error()}
	}
	return reviews[0], nil
}

// ContactObject is one contact as the API sends it.
func ContactObject(contact domain.Contact) Object {
	encoded, err := json.Marshal(contactsToJSON([]domain.Contact{contact})[0])
	if err != nil {
		panic(fmt.Sprintf("wire: encode contact: %v", err))
	}
	object, _ := ParseObject(encoded)
	return object
}

// AnswerObject is an answer as the API sends it (writers excluded, as for jobs).
func AnswerObject(answer domain.Answer) Object {
	jobIDs := answer.JobIDs
	if jobIDs == nil {
		jobIDs = []string{}
	}
	return marshalAll(map[string]any{
		"id": answer.ID, "question": answer.Question, "answer": answer.Answer, "jobIds": jobIDs,
		"createdAt": momentText(answer.CreatedAt), "answeredAt": momentText(answer.AnsweredAt),
	})
}

// WritersObject is a record's writers as the API's read-only `writers` key: owner entries only.
func WritersObject(writers domain.FieldWriters) json.RawMessage {
	return json.RawMessage(EncodeWriters(writers))
}

// Text reads a JSON string value; ok is false for anything else.
func Text(raw json.RawMessage) (string, bool) {
	text, err := parseText(raw)
	return text, err == nil
}

// WholeNumber reads a JSON whole number (3 or 3.0); ok is false for anything else.
func WholeNumber(raw json.RawMessage) (int, bool) {
	number, err := parseWholeNumber(raw)
	if err != nil {
		return 0, false
	}
	return *number, true
}
