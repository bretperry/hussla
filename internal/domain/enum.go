// Enum spelling: one table per enum maps each member to the string stored and sent over the API.
// In the app: every enum in this package (job status, work type, email status...) parses and prints through these two helpers.
// Used by: job.go, contact.go, company.go, email.go.

package domain

// enumName is the API spelling of member `value` in `names`, or "" for a value outside the table.
func enumName[E ~int](names []string, value E) string {
	index := int(value)
	if index < 0 || index >= len(names) {
		return ""
	}
	return names[index]
}

// parseEnum finds `text` in `names` (exact spelling) and returns its member.
func parseEnum[E ~int](names []string, text string) (E, bool) {
	for index, name := range names {
		if name == text {
			return E(index), true
		}
	}
	return E(0), false
}
