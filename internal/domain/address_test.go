// Tests for address parsing: the prototype's accept/refuse cases, list splitting and de-duplication, and properties over generated addresses.

package domain_test

import (
	"reflect"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/domain"
)

func TestIsPlainAddress(t *testing.T) {
	cases := map[string]bool{
		"jane@example.com":                  true,
		"jane.doe+jobs@mail.example.io":     true,
		"j@x.co":                            true,
		"jane@example":                      false,
		"jane@.com":                         false,
		"jane@example.":                     false,
		"@example.com":                      false,
		"jane@@example.com":                 false,
		"jane@exa@mple.com":                 false,
		"Jane <jane@example.com>":           false,
		"jane doe@example.com":              false,
		`"jane"@example.com`:                false,
		"jane@example.com\r\nBcc: x@y.z":    false,
		"jane;x@example.com":                false,
		"":                                  false,
		strings.Repeat("a", 250) + "@x.com": false,
	}
	for address, want := range cases {
		if got := domain.IsPlainAddress(address); got != want {
			t.Errorf("IsPlainAddress(%q) = %v, want %v", address, got, want)
		}
	}
}

func TestParseAddressList(t *testing.T) {
	got, err := domain.ParseAddressList("to", " jane@example.com, bob@example.com;JANE@example.com\n  ")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"jane@example.com", "bob@example.com"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v (split on , ; and space, repeats dropped ignoring case)", got, want)
	}
	if empty, err := domain.ParseAddressList("cc", "  "); err != nil || len(empty) != 0 {
		t.Fatalf("blank list = %v, %v; want empty, no error", empty, err)
	}
	if _, err := domain.ParseAddressList("to", "jane@example.com, not-an-address"); err == nil {
		t.Fatal("one bad address in a list: want an error")
	}
}

var addressPart = rapid.StringMatching(`[a-z0-9][a-z0-9._+-]{0,10}`)

// Property: a list of valid addresses joined any of the accepted ways parses back to itself.
func TestAddressListRoundTrips(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		addresses := rapid.SliceOfNDistinct(rapid.Custom(func(t *rapid.T) string {
			return addressPart.Draw(t, "local") + "@" + addressPart.Draw(t, "host") + ".com"
		}), 0, 5, strings.ToLower).Draw(t, "addresses")
		separator := rapid.SampledFrom([]string{",", ", ", ";", " ", "\n"}).Draw(t, "separator")
		got, err := domain.ParseAddressList("to", strings.Join(addresses, separator))
		if err != nil {
			t.Fatal(err)
		}
		if len(addresses) == 0 && len(got) == 0 {
			return
		}
		if !reflect.DeepEqual(got, addresses) {
			t.Fatalf("got %v, want %v", got, addresses)
		}
	})
}

// Property: no accepted address holds a character that could break out of a mail header.
func TestAcceptedAddressesAreHeaderSafe(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		address := rapid.String().Draw(t, "address")
		if domain.IsPlainAddress(address) && strings.ContainsAny(address, "\r\n\t <>,;\"\x00") {
			t.Fatalf("accepted %q", address)
		}
	})
}

func TestHeaderTextRefusesLineBreaksAndNul(t *testing.T) {
	for _, text := range []string{"Hi\r\nBcc: x@evil.example", "Hi\nthere", "Hi\rthere", "Hi\x00there"} {
		if domain.ValidateHeaderText("fromName", text) == nil {
			t.Errorf("ValidateHeaderText(%q) passed", text)
		}
		if _, err := domain.NewEmail("e", domain.EmailDraft{To: []string{"a@example.com"}, Subject: text, Body: "Hi", Kind: domain.EmailKindNote}, createdAt); err == nil {
			t.Errorf("subject %q was accepted", text)
		}
	}
	if err := domain.ValidateHeaderText("fromName", "Jane Doe – Staff Engineer"); err != nil {
		t.Errorf("a plain display name was refused: %v", err)
	}
	for _, address := range []string{"jane\x00@example.com", "jane@example.com\x00", "jane@exam\rple.com", "jane@example.com\n"} {
		if domain.IsPlainAddress(address) {
			t.Errorf("IsPlainAddress(%q) = true", address)
		}
	}
}
