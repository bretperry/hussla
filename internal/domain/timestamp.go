// Timestamps: the one stored and sent shape for a moment in time, UTC to the millisecond.
// In the app: every stored time and every time in the API; storage and the HTTP layer format and parse through these.
// Used by: every rule here that stamps "now"; storage and internal/httpapi (Phases 2-3).
//
// Fixed width ("2026-10-08T14:03:00.000Z", always 24 characters) so times sort correctly as text,
// in SQL and in a JSON diff. RFC 3339 with a variable fraction does not: ".5Z" sorts after ".45Z"
// but "Z" sorts after ".". Times are cut to the millisecond on the way in, so what the domain
// holds is exactly what a round trip through storage gives back.

package domain

import "time"

// TimestampLayout is the fixed-width UTC layout every stored time uses.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// FormatTimestamp writes a time as TimestampLayout in UTC; the zero time ("not set") is "".
func FormatTimestamp(moment time.Time) string {
	if moment.IsZero() {
		return ""
	}
	return NormalizeTime(moment).Format(TimestampLayout)
}

// ParseTimestamp reads any RFC 3339 time (any offset, any fraction) and returns it normalized;
// "" is the zero time.
func ParseTimestamp(text string) (time.Time, error) {
	if text == "" {
		return time.Time{}, nil
	}
	moment, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}, invalid("timestamp", `"`+text+`" isn't an RFC 3339 time like 2026-10-08T14:03:00Z`)
	}
	return NormalizeTime(moment), nil
}

// NormalizeTime is the moment in UTC, cut to the millisecond, with no monotonic clock reading,
// so two equal moments compare equal with == as well as Equal. The zero time stays zero.
func NormalizeTime(moment time.Time) time.Time {
	if moment.IsZero() {
		return time.Time{}
	}
	return moment.UTC().Truncate(time.Millisecond).Round(0)
}
