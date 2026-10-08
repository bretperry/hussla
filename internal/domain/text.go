// Text helpers: markdown to plain text for email bodies, and cutting text without splitting a character.
// In the app: a draft's body is stripped before it is sent or copied, since an inbox shows markdown raw.
// Used by: the email editor's defaults and the outbox (Phases 4-5), event.go, email.go.

package domain

import (
	"regexp"
	"unicode/utf8"
)

// The prototype's three rules, in its order: **bold**, *italic* (only after a space or at the
// start, so a lone "5 * 3" survives), and [text](url) → "text (url)" so the link still works in plain text.
var (
	markdownBold   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	markdownItalic = regexp.MustCompile(`(^|\s)\*([^*\n]+)\*`)
	markdownLink   = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
)

// MarkdownToPlain strips the markdown an agent's draft is likely to hold, leaving text an email
// client shows as written. Anything else (lists, line breaks) is already readable as plain text.
func MarkdownToPlain(markdown string) string {
	text := markdownBold.ReplaceAllString(markdown, "$1")
	text = markdownItalic.ReplaceAllString(text, "$1$2")
	return markdownLink.ReplaceAllString(text, "$1 ($2)")
}

// truncateUTF8 cuts text to at most maxBytes bytes without splitting a UTF-8 character.
func truncateUTF8(text string, maxBytes int) string {
	if len(text) <= maxBytes {
		return text
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}
