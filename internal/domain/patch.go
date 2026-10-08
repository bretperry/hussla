// Patch fields: one value that is absent, set, or cleared, so a write speaks only for what it names.
// In the app: every PATCH (jobs, companies, answers) is a struct of these; a field the client never sent stays as stored.
// Used by: job.go, company.go, answer.go; the HTTP layer builds them from JSON (absent key, value, null).
//
// Why not pointers: a pointer has two states (nil, value) and a patch needs three (absent, value,
// null). Collapsing absent and null is exactly the bug "a client deletes what it never rendered".

package domain

import "strings"

// fieldState is which of the three states a Field is in. The zero value is absent, so a
// zero-valued patch struct changes nothing.
type fieldState int

const (
	fieldAbsent fieldState = iota
	fieldSet
	fieldCleared
)

// Field is one patchable value: absent (leave it alone), set (replace it), or cleared (JSON null).
type Field[T any] struct {
	state fieldState
	value T
}

// Set names a field with a new value.
func Set[T any](value T) Field[T] { return Field[T]{state: fieldSet, value: value} }

// Clear names a field with JSON null: the stored value goes back to its zero (empty, nil, none).
func Clear[T any]() Field[T] { return Field[T]{state: fieldCleared} }

// IsAbsent is true when the patch didn't name this field.
func (field Field[T]) IsAbsent() bool { return field.state == fieldAbsent }

// IsSet is true when the patch named this field with a value (not null).
func (field Field[T]) IsSet() bool { return field.state == fieldSet }

// IsCleared is true when the patch named this field with null.
func (field Field[T]) IsCleared() bool { return field.state == fieldCleared }

// Value is the new value when IsSet; the zero value otherwise.
func (field Field[T]) Value() T { return field.value }

// Apply returns what the stored value becomes: unchanged when absent, the new value when set,
// the zero value when cleared.
func (field Field[T]) Apply(current T) T {
	switch field.state {
	case fieldSet:
		return field.value
	case fieldCleared:
		var zero T
		return zero
	case fieldAbsent:
		return current
	}
	return current
}

// trimmed is the field with surrounding space taken off a set value, for names and titles; a
// stored value the patch doesn't name is left exactly as it is.
func trimmed(field Field[string]) Field[string] {
	if field.IsSet() {
		return Set(strings.TrimSpace(field.Value()))
	}
	return field
}

// RawJSON is one JSON value kept verbatim (an object, array, string, number or bool). The domain
// never looks inside it; the HTTP layer and storage encode and decode it.
type RawJSON string

// Extras holds the top-level fields an agent sent that Hussla has no named field for, by key.
// The prototype stored any field it was given, and agents still send ones the API doesn't list
// (a "statusNote", a "...FetchedAt"); dropping them would lose what an agent found.
type Extras map[string]RawJSON

// ExtrasPatch names extra fields to set (a value) or remove (Clear); keys it doesn't name stay.
type ExtrasPatch map[string]Field[RawJSON]

// MaxExtraFields caps how many extra fields one record holds, so a runaway agent can't grow a row without bound.
const MaxExtraFields = 50

// applyExtras merges a patch into the stored extras and returns a new map; the stored one is never mutated.
func applyExtras(current Extras, patch ExtrasPatch) Extras {
	if len(current) == 0 && len(patch) == 0 {
		return current
	}
	merged := make(Extras, len(current)+len(patch))
	for key, value := range current {
		merged[key] = value
	}
	for key, field := range patch {
		switch {
		case field.IsSet():
			merged[key] = field.Value()
		case field.IsCleared():
			delete(merged, key)
		}
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

// validateExtrasPatch refuses an extra field that shadows a named one, so a patch can't store the
// same fact twice under one name, and refuses a record that would grow past MaxExtraFields.
func validateExtrasPatch(current Extras, patch ExtrasPatch, named map[string]bool) error {
	for key := range patch {
		if key == "" {
			return &ValidationError{Field: "(extra)", Problem: "a field name can't be empty"}
		}
		if named[key] {
			return &ValidationError{Field: key, Problem: "is a named field; it can't also be an extra one"}
		}
	}
	if len(applyExtras(current, patch)) > MaxExtraFields {
		return &ValidationError{Field: "(extra)", Problem: "too many unlisted fields on one record"}
	}
	return nil
}
