// Tests for MarkdownToPlain: the prototype's three rules, and that text with no markdown passes through untouched.

package domain_test

import (
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/domain"
)

func TestMarkdownToPlain(t *testing.T) {
	cases := map[string]string{
		"**Staff Engineer** role": "Staff Engineer role",
		"I *really* enjoyed it":   "I really enjoyed it",
		"*Hi*,":                   "Hi,",
		"5 * 3 = 15":              "5 * 3 = 15",
		"rate*limit*ing":          "rate*limit*ing",
		"See [the posting](https://example.com/jobs/1).":  "See the posting (https://example.com/jobs/1).",
		"**Bold** and [link](https://x.example) and *em*": "Bold and link (https://x.example) and em",
		"Line one\n\n- a bullet\n- another":               "Line one\n\n- a bullet\n- another",
		"":                                                "",
	}
	for markdown, want := range cases {
		if got := domain.MarkdownToPlain(markdown); got != want {
			t.Errorf("MarkdownToPlain(%q) = %q, want %q", markdown, got, want)
		}
	}
}

// Property: text with none of the markers (* [ ]) comes back exactly as it went in.
func TestMarkdownToPlainLeavesPlainTextAlone(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		text := rapid.String().Draw(t, "text")
		if strings.ContainsAny(text, "*[]") {
			t.Skip("has a marker")
		}
		if got := domain.MarkdownToPlain(text); got != text {
			t.Fatalf("MarkdownToPlain(%q) = %q, want it unchanged", text, got)
		}
	})
}
