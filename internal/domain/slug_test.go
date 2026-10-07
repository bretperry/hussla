// Tests for Slugify: known names, and properties that must hold for any input.

package domain

import (
	"regexp"
	"testing"

	"pgregory.net/rapid"
)

func TestSlugifyKnownNames(t *testing.T) {
	cases := map[string]string{
		"Ramp":                 "ramp",
		"  Grafana Labs ":      "grafana-labs",
		"Café Labs, Inc.":      "cafe-labs-inc",
		"Fora_Travel -- NYC":   "fora-travel-nyc",
		"!!!":                  "",
		"Included Health (IT)": "included-health-it",
	}
	for name, want := range cases {
		if got := Slugify(name); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", name, got, want)
		}
	}
}

var slugShape = regexp.MustCompile(`^([a-z0-9]+(-[a-z0-9]+)*)?$`)

func TestSlugifyProperties(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		name := rapid.String().Draw(t, "name")
		slug := Slugify(name)
		if !slugShape.MatchString(slug) {
			t.Fatalf("Slugify(%q) = %q, not lowercase words joined by single hyphens", name, slug)
		}
		if len(slug) > MaxSlugLength {
			t.Fatalf("Slugify(%q) is %d bytes, over %d", name, len(slug), MaxSlugLength)
		}
		if again := Slugify(slug); again != slug {
			t.Fatalf("not idempotent: %q → %q → %q", name, slug, again)
		}
	})
}
