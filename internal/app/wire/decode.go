// JSON in and out of domain records: the one codec for the stored form, the backup bundle and (Phase 3) the HTTP API.
// In the app: every agent write is a JSON object that becomes a patch here; every stored row is read back through here.
// Used by: the SQLite adapter (rows hold API-named JSON), the seed import, and the HTTP layer (Phase 3).
// Uses: internal/domain only; keys are the names in api/openapi.yaml.
//
// Three states per key, as decision 0009 says: absent leaves the field alone, a value sets it,
// null clears it. A key the domain has no field for becomes an extra, kept verbatim.
//
// Strict or lenient: the API decodes strictly (a wrong type is a ValidationError naming the key).
// Stored rows and old seed files decode leniently: a value of the wrong type or an unknown enum
// spelling is skipped with a warning instead of making the whole record unreadable, because a
// record Bret can open with one blank field beats a record he can't open at all.

package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

// Object is one JSON object whose values are kept raw until a field asks for them.
type Object map[string]json.RawMessage

// ParseObject reads one JSON object. Anything else (an array, a string, null) is a ValidationError.
func ParseObject(raw []byte) (Object, error) {
	var object Object
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, &domain.ValidationError{Field: "(body)", Problem: "must be a JSON object"}
	}
	return object, nil
}

// Decoder turns JSON objects into patches. The zero Decoder is strict.
type Decoder struct {
	// Lenient skips a value that can't be read (and says so in Warnings) instead of failing.
	Lenient  bool
	warnings []string
}

// Warnings lists what lenient decoding skipped, in order ("workType: must be ...").
func (decoder *Decoder) Warnings() []string { return decoder.warnings }

// problem is the outcome of a value that couldn't be read: an error when strict, a warning when lenient.
func (decoder *Decoder) problem(key string, cause error) error {
	var validation *domain.ValidationError
	message := cause.Error()
	if errors.As(cause, &validation) {
		message = validation.Problem
	}
	if decoder.Lenient {
		decoder.warnings = append(decoder.warnings, key+": "+message)
		return nil
	}
	return &domain.ValidationError{Field: key, Problem: message}
}

func isNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// decodeField reads one key into a three-state Field using `parse` for a non-null value.
func decodeField[T any](decoder *Decoder, object Object, key string, parse func(json.RawMessage) (T, error)) (domain.Field[T], error) {
	raw, present := object[key]
	if !present {
		return domain.Field[T]{}, nil
	}
	if isNull(raw) {
		return domain.Clear[T](), nil
	}
	value, err := parse(raw)
	if err != nil {
		return domain.Field[T]{}, decoder.problem(key, err)
	}
	return domain.Set(value), nil
}

func parseText(raw json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", errors.New("must be text")
	}
	return text, nil
}

func parseTexts(raw json.RawMessage) ([]string, error) {
	texts := []string{}
	if err := json.Unmarshal(raw, &texts); err != nil {
		return nil, errors.New("must be a list of text")
	}
	return texts, nil
}

// parseWholeNumber accepts 72 and 72.0 (agents write both) but not 72.5.
func parseWholeNumber(raw json.RawMessage) (*int, error) {
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil || number != float64(int(number)) {
		return nil, errors.New("must be a whole number")
	}
	whole := int(number)
	return &whole, nil
}

// parseMoment reads a time: RFC 3339 in any offset, or a bare date (UTC midnight) like the prototype's.
func parseMoment(raw json.RawMessage) (time.Time, error) {
	text, err := parseText(raw)
	if err != nil {
		return time.Time{}, err
	}
	if date, dateErr := time.Parse(time.DateOnly, text); dateErr == nil {
		return domain.NormalizeTime(date), nil
	}
	return domain.ParseTimestamp(text)
}

func textField(decoder *Decoder, object Object, key string) (domain.Field[string], error) {
	return decodeField(decoder, object, key, parseText)
}

func textsField(decoder *Decoder, object Object, key string) (domain.Field[[]string], error) {
	return decodeField(decoder, object, key, parseTexts)
}

func wholeField(decoder *Decoder, object Object, key string) (domain.Field[*int], error) {
	return decodeField(decoder, object, key, parseWholeNumber)
}

func momentField(decoder *Decoder, object Object, key string) (domain.Field[time.Time], error) {
	return decodeField(decoder, object, key, parseMoment)
}

// enumField reads a text key and parses it with `parseName`; a spelling it rejects is a problem.
func enumField[E any](decoder *Decoder, object Object, key string, parseName func(string) (E, error)) (domain.Field[E], error) {
	return decodeField(decoder, object, key, func(raw json.RawMessage) (E, error) {
		text, err := parseText(raw)
		if err != nil {
			var zero E
			return zero, err
		}
		return parseName(text)
	})
}

// firstError returns the first non-nil error; it keeps a long run of field reads readable.
func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// extrasPatch turns every key the domain has no field for into an extras patch entry.
func extrasPatch(object Object, isNamed func(string) bool) domain.ExtrasPatch {
	var patch domain.ExtrasPatch
	for key, raw := range object {
		if isNamed(key) {
			continue
		}
		if patch == nil {
			patch = domain.ExtrasPatch{}
		}
		if isNull(raw) {
			patch[key] = domain.Clear[domain.RawJSON]()
		} else {
			patch[key] = domain.Set(domain.RawJSON(raw))
		}
	}
	return patch
}

// extrasOf is the stored extras a patch of an empty record would produce: set entries only.
func extrasOf(patch domain.ExtrasPatch) domain.Extras {
	var extras domain.Extras
	for key, field := range patch {
		if !field.IsSet() {
			continue
		}
		if extras == nil {
			extras = domain.Extras{}
		}
		extras[key] = field.Value()
	}
	return extras
}

// marshalAll turns a map of plain values into an Object, each value as JSON.
func marshalAll(values map[string]any) Object {
	object := make(Object, len(values))
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			// Every value here is text, numbers, bools, lists or structs of those: Marshal can't fail.
			panic(fmt.Sprintf("wire: encode %s: %v", key, err))
		}
		object[key] = encoded
	}
	return object
}

// addExtras puts a record's extra fields into its object; a named key already there wins.
func addExtras(object Object, extras domain.Extras) {
	for key, raw := range extras {
		if _, taken := object[key]; !taken {
			object[key] = json.RawMessage(raw)
		}
	}
}

// momentText is a time as the API writes it: fixed-width UTC text, or nil (JSON null) when unset.
func momentText(moment time.Time) *string {
	if moment.IsZero() {
		return nil
	}
	text := domain.FormatTimestamp(moment)
	return &text
}

// listOrNull keeps the difference between "no list" (null) and an empty list ([]) the domain keeps.
func listOrNull[T any](list []T) any {
	if list == nil {
		return nil
	}
	return list
}

// The list fields the API contract types as arrays, never null.
var (
	JobListFields     = []string{"reasons", "scamFlags", "contacts", "sources"}
	CompanyListFields = []string{"facts", "anecdotes", "news", "reviews", "sources"}
)

// EmptyListsForNull writes [] where listOrNull wrote null; the API and MCP answers call it, storage doesn't.
//
// Storage keeps null and [] apart, but the contract promises an array, and the UI crashed on a
// company whose reviews were null (blank page, "t.reviews is null").
func EmptyListsForNull(object Object, keys []string) {
	for _, key := range keys {
		if value, ok := object[key]; ok && string(value) == "null" {
			object[key] = json.RawMessage("[]")
		}
	}
}

// EncodeWriters is how a record's per-field writers are stored: the names of the owner-written
// fields only, since agent is the default (decision 0009).
func EncodeWriters(writers domain.FieldWriters) string {
	owned := make(map[string]string, len(writers))
	for field, writer := range writers {
		if writer == domain.WriterOwner {
			owned[field] = writer.String()
		}
	}
	encoded, err := json.Marshal(owned)
	if err != nil {
		panic(fmt.Sprintf("wire: encode writers: %v", err))
	}
	return string(encoded)
}

// DecodeWriters reads EncodeWriters' text back. A damaged cell is an error, never "no owner
// entries": guessing would silently drop the protection of what the owner wrote.
func DecodeWriters(text string) (domain.FieldWriters, error) {
	text = strings.TrimSpace(text)
	if text == "" || text == "null" {
		return nil, nil
	}
	var named map[string]string
	if err := json.Unmarshal([]byte(text), &named); err != nil {
		return nil, fmt.Errorf("writers %q: %w", text, err)
	}
	var writers domain.FieldWriters
	for field, name := range named {
		if name != domain.WriterOwner.String() {
			continue
		}
		if writers == nil {
			writers = domain.FieldWriters{}
		}
		writers[field] = domain.WriterOwner
	}
	return writers, nil
}
