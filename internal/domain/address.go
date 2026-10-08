// Email addresses: parse the list a person or agent typed ("a@x.com, b@y.com") and refuse anything that isn't one plain address.
// In the app: every email's To and Cc, on create and on edit, before anything reaches a mail server.
// Used by: email.go; the HTTP layer parses a typed string with ParseAddressList.
//
// Deliberately narrower than RFC 5322 (the prototype's rule): local@domain.tld with no spaces,
// quotes, angle brackets, commas or semicolons. "Jane <jane@x.com>" is refused, because the
// display-name forms are where header-injection and wrong-recipient bugs live, and agents only
// ever need the bare address.

package domain

import (
	"strings"
	"unicode"
)

// MaxAddressLength is the longest address SMTP carries (RFC 5321's 254-octet path limit).
const MaxAddressLength = 254

// isAddressSeparator splits a typed list: commas, semicolons and any whitespace (the prototype's).
func isAddressSeparator(character rune) bool {
	return character == ',' || character == ';' || unicode.IsSpace(character)
}

// ParseAddressList splits a typed list into addresses and validates each; an empty text is an empty list.
func ParseAddressList(field, text string) ([]string, error) {
	return ValidateAddresses(field, strings.FieldsFunc(text, isAddressSeparator))
}

// ValidateAddresses checks each address, trims it, and drops repeats (ignoring case), keeping the first spelling.
func ValidateAddresses(field string, addresses []string) ([]string, error) {
	valid := make([]string, 0, len(addresses))
	seen := make(map[string]bool, len(addresses))
	for _, address := range addresses {
		address = strings.TrimSpace(address)
		if address == "" {
			continue
		}
		if !IsPlainAddress(address) {
			return nil, invalid(field, `"`+address+`" isn't an email address`)
		}
		key := strings.ToLower(address)
		if seen[key] {
			continue
		}
		seen[key] = true
		valid = append(valid, address)
	}
	return valid, nil
}

// IsPlainAddress accepts local@domain where the domain has a dot with something on both sides,
// and neither part holds whitespace, a control character, or any of @ < > , ; ".
func IsPlainAddress(address string) bool {
	if len(address) > MaxAddressLength {
		return false
	}
	local, domainPart, found := strings.Cut(address, "@")
	return found && isAddressPart(local) && isAddressPart(domainPart) && hasInnerDot(domainPart)
}

// isAddressPart is true for non-empty text with none of the characters an address part can't hold.
func isAddressPart(text string) bool {
	if text == "" {
		return false
	}
	for _, character := range text {
		if unicode.IsSpace(character) || unicode.IsControl(character) || strings.ContainsRune(`@<>,;"`, character) {
			return false
		}
	}
	return true
}

// hasInnerDot is true when some dot in the text has a character before and after it ("x.com", not ".com" or "x.").
func hasInnerDot(text string) bool {
	for index := 1; index < len(text)-1; index++ {
		if text[index] == '.' {
			return true
		}
	}
	return false
}
