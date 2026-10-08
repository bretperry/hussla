// The mail ports: MailSender (one per provider kind), SecretStore (encrypted credentials), and what a send's failure means.
// In the app: every email that leaves, the "send test" button, the mail password the owner pastes once.
// Used by: the mail adapters (smtpmail, resend, postmark, sendgrid, mailgun, secretfile, mailfactory), Service, internal/app/outbox.
// Uses: config.MailProvider for a connection's settings.
//
// Never send twice: a failed send is retried only when the adapter is sure nothing went out
// (before SMTP DATA, or before an HTTP request was written). An adapter says so with a
// DeliveryError; any other error, and the zero Delivery, mean "may have been sent", so a new
// adapter that forgets to classify fails safe (the owner checks) instead of sending again.

package mailsetup

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// Secret is a credential (a mail password, an API key). It prints, marshals and logs as
// "[redacted]" in every form, so a struct holding one can't leak it by being logged or returned;
// Reveal is the one way to read it, and only an adapter that hands it to a provider calls it.
//
// The value sits behind a pointer: fmt can't call methods on a value reached through an
// unexported field, so a struct that keeps a Secret privately would otherwise print it raw;
// behind a pointer it prints as an address.
type Secret struct {
	value *string
}

// redactedText is what a Secret shows instead of itself.
const redactedText = "[redacted]"

// NewSecret wraps a credential.
func NewSecret(value string) Secret { return Secret{value: &value} }

// Reveal returns the credential, for the adapter that sends it to the provider.
func (secret Secret) Reveal() string {
	if secret.value == nil {
		return ""
	}
	return *secret.value
}

// IsEmpty is true when no credential is held.
func (secret Secret) IsEmpty() bool { return secret.Reveal() == "" }

func (Secret) String() string   { return redactedText }
func (Secret) GoString() string { return redactedText }

// Format covers every fmt verb (%v, %+v, %#v, %s, %q, %x), so no format string reveals it.
func (Secret) Format(state fmt.State, _ rune) { _, _ = state.Write([]byte(redactedText)) }

// MarshalText makes encoding/json and log/slog (both handlers) write "[redacted]".
func (Secret) MarshalText() ([]byte, error) { return []byte(redactedText), nil }

// Address is a sender: a plain address and an optional display name.
type Address struct {
	Email string
	Name  string
}

// Message is one email as a provider receives it. Every header field was validated by the domain;
// adapters refuse CR, LF and NUL in each again before writing a byte (security model).
type Message struct {
	From    Address
	To      []string
	Cc      []string
	Subject string
	Body    string // plain text, UTF-8
	// MessageID is the deterministic Message-ID (without angle brackets): the same email at the
	// same version always gets the same one, so a resend after "may have been sent" threads as a duplicate.
	MessageID string
	// IdempotencyKey is sent where the provider honors one (Resend), so a retried request is not a second email.
	IdempotencyKey string
}

// ValidateMessage is every adapter's own check before a byte is written: no CR, LF or NUL in any
// header value, plain addresses only, a recipient and a well-formed Message-ID. The domain checked
// first; this catches a caller that skipped it. Errors are DeliveryNotSentRefused.
func ValidateMessage(message Message) error {
	headerValues := []struct{ name, value string }{
		{"from name", message.From.Name},
		{"subject", message.Subject},
		{"Message-ID", message.MessageID},
		{"idempotency key", message.IdempotencyKey},
	}
	for _, header := range headerValues {
		if err := domain.ValidateHeaderText(header.name, header.value); err != nil {
			return NotSentRefused("refused to send: " + err.Error())
		}
	}
	if message.MessageID == "" || strings.ContainsAny(message.MessageID, "<> ") || !strings.Contains(message.MessageID, "@") {
		return NotSentRefused("refused to send: the Message-ID is missing or malformed")
	}
	if len(message.To) == 0 {
		return NotSentRefused("refused to send: no recipient")
	}
	addresses := append(append([]string{message.From.Email}, message.To...), message.Cc...)
	for _, address := range addresses {
		if !domain.IsPlainAddress(address) {
			return NotSentRefused(fmt.Sprintf("refused to send: %q isn't a plain email address", address))
		}
	}
	return nil
}

// Receipt is what the provider said when it took the message.
type Receipt struct {
	ProviderMessageID string
}

// MailSender hands one message to a provider. Errors: a *DeliveryError saying whether it may have
// gone out; anything else counts as "may have been sent". A sender never retries by itself.
type MailSender interface {
	Send(ctx context.Context, message Message) (Receipt, error)
}

// Connection is everything an adapter needs to reach one configured provider.
type Connection struct {
	Provider config.MailProvider
	Host     string // SMTP
	Port     int    // SMTP
	Security config.MailSecurity
	BaseURL  string // API: scheme and host
	Username string // SMTP
	Domain   string // Mailgun's sending domain
	Secret   Secret
}

// SenderFactory builds the sender for a connection (the composition root wires mailfactory.New).
// Errors: a *DeliveryError with DeliveryNotSentRefused when the connection can't work at all.
type SenderFactory func(connection Connection) (MailSender, error)

// ErrSecretNotFound: no secret is stored under that name.
var ErrSecretNotFound = errors.New("secret not found")

// ErrSecretUnreadable: a secret is stored but can't be decrypted (a different key file, or a damaged store).
var ErrSecretUnreadable = errors.New("secret can't be decrypted with this key")

// SecretStore keeps credentials encrypted at rest. Errors: ErrSecretNotFound, ErrSecretUnreadable.
type SecretStore interface {
	// Get returns the secret stored under name.
	Get(ctx context.Context, name string) (Secret, error)
	// Put stores the secret under name, replacing any earlier one, durably before it returns.
	Put(ctx context.Context, name string, secret Secret) error
}

// Delivery is what a failed send means for the email.
type Delivery int

const (
	// DeliveryMaybeSent: the provider may have taken it (cut off after DATA or after the request
	// was written). The zero value, so an unclassified failure is the safe one: never resent by itself.
	DeliveryMaybeSent Delivery = iota
	// DeliveryNotSentRetry: definitely not sent, and trying again later may work (a timeout before
	// DATA, a dropped connection, a 4xx SMTP reply, HTTP 429 or 503).
	DeliveryNotSentRetry
	// DeliveryNotSentRefused: definitely not sent, and trying again won't help until the owner fixes
	// something (a wrong password, a refused recipient, a rejected request).
	DeliveryNotSentRefused
)

var deliveryNames = []string{"maybe-sent", "not-sent-retry", "not-sent-refused"}

func (delivery Delivery) String() string {
	if int(delivery) < 0 || int(delivery) >= len(deliveryNames) {
		return fmt.Sprintf("Delivery(%d)", int(delivery))
	}
	return deliveryNames[delivery]
}

// DeliveryError is a failed send and what it means. Reason is safe to show the owner and to store:
// adapters build it from the provider's reply with every credential removed.
type DeliveryError struct {
	Delivery Delivery
	Reason   string
}

func (deliveryError *DeliveryError) Error() string { return deliveryError.Reason }

// NotSentRetry builds a DeliveryError for a failure that sent nothing and may pass later.
func NotSentRetry(reason string) error {
	return &DeliveryError{Delivery: DeliveryNotSentRetry, Reason: reason}
}

// NotSentRefused builds a DeliveryError for a failure that sent nothing and needs the owner.
func NotSentRefused(reason string) error {
	return &DeliveryError{Delivery: DeliveryNotSentRefused, Reason: reason}
}

// MaybeSent builds a DeliveryError for a failure after the provider may have taken the message.
func MaybeSent(reason string) error {
	return &DeliveryError{Delivery: DeliveryMaybeSent, Reason: reason}
}

// DeliveryOf classifies a send's error; anything that isn't a *DeliveryError may have been sent.
func DeliveryOf(err error) Delivery {
	var deliveryError *DeliveryError
	if errors.As(err, &deliveryError) {
		return deliveryError.Delivery
	}
	return DeliveryMaybeSent
}
