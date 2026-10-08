// Company slugs: the stable, URL-safe id a company page lives at (/companies/<slug>).
// In the app: the same company named by two agents ("Ramp", "ramp ") lands on one page.
// Used by: company storage and import (later phases).

package domain

import (
	"strings"
	"unicode"
)

// MaxSlugLength caps a slug so a pasted paragraph can't become a URL.
const MaxSlugLength = 120

// Slugify turns a display name into a slug: lowercase ASCII letters and digits joined by single
// hyphens, with accents folded to their base letter where it is a plain Latin one and every other
// character dropped. An empty result means the name had nothing usable in it.
func Slugify(name string) string {
	var builder strings.Builder
	pendingHyphen := false
	for _, character := range strings.ToLower(name) {
		character = foldAccent(character)
		switch {
		case (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'):
			if pendingHyphen && builder.Len() > 0 {
				builder.WriteByte('-')
			}
			pendingHyphen = false
			builder.WriteRune(character)
		case unicode.IsSpace(character) || character == '-' || character == '_':
			pendingHyphen = true
		}
		if builder.Len() >= MaxSlugLength {
			break
		}
	}
	slug := builder.String()
	if len(slug) > MaxSlugLength {
		slug = slug[:MaxSlugLength]
	}
	return strings.TrimRight(slug, "-")
}

// foldAccent maps the common accented Latin letters to their base letter ("é" → "e"), so
// "Café Labs" and "Cafe Labs" share a page. Anything else comes back unchanged.
func foldAccent(character rune) rune {
	switch character {
	case 'à', 'á', 'â', 'ã', 'ä', 'å':
		return 'a'
	case 'ç':
		return 'c'
	case 'è', 'é', 'ê', 'ë':
		return 'e'
	case 'ì', 'í', 'î', 'ï':
		return 'i'
	case 'ñ':
		return 'n'
	case 'ò', 'ó', 'ô', 'õ', 'ö':
		return 'o'
	case 'ù', 'ú', 'û', 'ü':
		return 'u'
	case 'ý', 'ÿ':
		return 'y'
	default:
		return character
	}
}
