// Tests for timestamps: fixed width, sorts as text, round-trips, and normalizes any offset to UTC milliseconds.

package domain_test

import (
	"testing"
	"time"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/domain"
)

func TestFormatAndParseTimestamp(t *testing.T) {
	moment := time.Date(2026, 10, 8, 10, 3, 0, 500_600_700, time.FixedZone("EDT", -4*3600))
	if got := domain.FormatTimestamp(moment); got != "2026-10-08T14:03:00.500Z" {
		t.Fatalf("FormatTimestamp = %q", got)
	}
	if domain.FormatTimestamp(time.Time{}) != "" {
		t.Fatal("the zero time must format as empty")
	}
	parsed, err := domain.ParseTimestamp("2026-10-08T10:03:00.5006-04:00")
	if err != nil || parsed != time.Date(2026, 10, 8, 14, 3, 0, 500_000_000, time.UTC) {
		t.Fatalf("ParseTimestamp = %v, %v", parsed, err)
	}
	if _, err := domain.ParseTimestamp("October 8"); err == nil {
		t.Fatal("a non-RFC 3339 time: want an error")
	}
}

// Property: formatted timestamps are always 24 characters, sort as text in time order, and parse back to the same moment.
func TestTimestampsSortAsText(t *testing.T) {
	drawMoment := func(t *rapid.T, label string) time.Time {
		return time.Unix(0, rapid.Int64Range(0, 4_000_000_000_000_000_000).Draw(t, label)).
			In(time.FixedZone("zone", rapid.IntRange(-12, 14).Draw(t, label+"Offset")*3600))
	}
	rapid.Check(t, func(t *rapid.T) {
		left, right := drawMoment(t, "left"), drawMoment(t, "right")
		leftText, rightText := domain.FormatTimestamp(left), domain.FormatTimestamp(right)
		if len(leftText) != len(domain.TimestampLayout) || len(rightText) != len(domain.TimestampLayout) {
			t.Fatalf("not fixed width: %q, %q", leftText, rightText)
		}
		leftTime, rightTime := domain.NormalizeTime(left), domain.NormalizeTime(right)
		if (leftText < rightText) != leftTime.Before(rightTime) {
			t.Fatalf("%q < %q is %v, but %v before %v is %v", leftText, rightText, leftText < rightText, leftTime, rightTime, leftTime.Before(rightTime))
		}
		parsed, err := domain.ParseTimestamp(leftText)
		if err != nil || parsed != leftTime {
			t.Fatalf("round trip %q → %v (%v), want %v", leftText, parsed, err, leftTime)
		}
	})
}
