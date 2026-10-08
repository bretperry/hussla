// Field provenance: who last wrote each field of a record (the owner or an agent), and the rule that agents can't undo the owner.
// In the app: every job, company and answer patch checks it; the job page can mark owner-written fields.
// Used by: job.go, company.go, answer.go; the activity log keeps PatchResult.Before for restores (Phase 3).
//
// Security model (docs/plans/hussla-v1.md): agent writes are reversible. An agent patch may not
// clear or overwrite a field the owner last wrote; the whole patch is refused and names those
// fields, so the agent can resend without them. Every patch result carries the record as it was,
// so the log can keep each changed field's prior value. A field with no recorded writer (imported
// or older data) counts as agent-written: only what the owner actually wrote is protected.

package domain

import (
	"slices"
	"strings"
)

// Writer is who made a write. The zero value is WriterAgent, so a write whose author was never
// set is treated as the restricted kind (fail closed).
type Writer int

const (
	WriterAgent Writer = iota
	WriterOwner
)

var writerNames = []string{"agent", "owner"}

func (writer Writer) String() string { return enumName(writerNames, writer) }

// ParseWriter reads an API spelling ("agent", "owner").
func ParseWriter(text string) (Writer, error) {
	writer, ok := parseEnum[Writer](writerNames, text)
	if !ok {
		return WriterAgent, invalid("writer", `must be "agent" or "owner"`)
	}
	return writer, nil
}

// FieldWriters records the last writer of each field, keyed by the field's API name. A
// followup key is "followup.<key>" (followup merges by key, so each key has its own writer);
// an extra field is its own key. A field with no entry was never written by the owner.
type FieldWriters map[string]Writer

// OwnerFieldsError refuses an agent patch that would clear or overwrite fields the owner last
// wrote; Fields lists them, sorted. It unwraps to ErrOwnerField.
type OwnerFieldsError struct {
	Fields []string
}

func (ownerFieldsError *OwnerFieldsError) Error() string {
	return "the owner last wrote " + strings.Join(ownerFieldsError.Fields, ", ") + "; an agent can't change it: leave it out and resend"
}

func (ownerFieldsError *OwnerFieldsError) Unwrap() error { return ErrOwnerField }

// PatchResult is a record after a patch, the record before it, and the API names of the fields
// whose value changed (sorted). Restoring is a patch that sets those fields back from Before.
type PatchResult[R any] struct {
	Record  R
	Before  R
	Changed []string
}

// fieldComparison names one field and says whether two records hold the same value in it.
type fieldComparison[R any] struct {
	name string
	same func(before, after R) bool
}

// changedFields lists the names of the fields that differ between two records, in table order.
func changedFields[R any](table []fieldComparison[R], before, after R) []string {
	var changed []string
	for _, field := range table {
		if !field.same(before, after) {
			changed = append(changed, field.name)
		}
	}
	return changed
}

// changedExtras lists the extra keys whose value differs (added, changed or removed).
func changedExtras(before, after Extras) []string {
	var changed []string
	for key, value := range after {
		if previous, ok := before[key]; !ok || previous != value {
			changed = append(changed, key)
		}
	}
	for key := range before {
		if _, ok := after[key]; !ok {
			changed = append(changed, key)
		}
	}
	return changed
}

// settleWriters applies the provenance rule to a computed change: an agent touching an
// owner-written field refuses the whole patch; otherwise every changed field records the writer.
// It returns the new writers map (the old one is not mutated) and the sorted changed names.
func settleWriters(current FieldWriters, changed []string, writer Writer) (FieldWriters, []string, error) {
	slices.Sort(changed)
	if writer == WriterAgent {
		var refused []string
		for _, name := range changed {
			if current[name] == WriterOwner {
				refused = append(refused, name)
			}
		}
		if len(refused) > 0 {
			return nil, nil, &OwnerFieldsError{Fields: refused}
		}
	}
	if len(changed) == 0 {
		return current, changed, nil
	}
	next := make(FieldWriters, len(current)+len(changed))
	for name, previous := range current {
		next[name] = previous
	}
	for _, name := range changed {
		if writer == WriterOwner {
			next[name] = WriterOwner
		} else {
			// Agent-written is the default, so the map only needs to forget an owner entry.
			delete(next, name)
		}
	}
	if len(next) == 0 {
		return nil, changed, nil
	}
	return next, changed, nil
}

// Equality helpers for the field tables.
func sameIntPointer(left, right *int) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func sameInt64Pointer(left, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func sameFloatPointer(left, right *float64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

// sameList treats nil and empty as different, as the API does (null vs []).
func sameList[T comparable](left, right []T) bool {
	return (left == nil) == (right == nil) && slices.Equal(left, right)
}

func sameListFunc[T any](left, right []T, same func(T, T) bool) bool {
	return (left == nil) == (right == nil) && slices.EqualFunc(left, right, same)
}
