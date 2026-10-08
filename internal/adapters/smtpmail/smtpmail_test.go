// Tests for the SMTP adapter against the in-process fake server: TLS modes, login, encoding, refusals and the never-send-twice line.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package smtpmail_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/smtpmail"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
)

const (
	testUser     = "jane@example.com"
	testPassword = "abcd-efgh-ijkl-mnop" // synthetic
)

func connectionTo(server *fakeServer, security config.MailSecurity) mailsetup.Connection {
	return mailsetup.Connection{
		Host: "127.0.0.1", Port: server.port(), Security: security,
		Username: testUser, Secret: mailsetup.NewSecret(testPassword),
	}
}

func newSender(t *testing.T, server *fakeServer, security config.MailSecurity, options smtpmail.Options) *smtpmail.Sender {
	t.Helper()
	options.RootCAs = server.roots
	if options.ConnectTimeout == 0 {
		options.ConnectTimeout = 5 * time.Second
	}
	if options.DeliveryTimeout == 0 {
		options.DeliveryTimeout = 5 * time.Second
	}
	sender, err := smtpmail.New(connectionTo(server, security), options)
	if err != nil {
		t.Fatal(err)
	}
	return sender
}

func sampleMessage() mailsetup.Message {
	return mailsetup.Message{
		From:      mailsetup.Address{Email: "jane@example.com", Name: "Jane Doe"},
		To:        []string{"recruiter@example.org"},
		Cc:        []string{"hiring@example.org"},
		Subject:   "Following up",
		Body:      "Hi,\nThanks for your time.\n",
		MessageID: "hussla.e1.v1@example.com",
	}
}

func deliveryOf(t *testing.T, err error) mailsetup.Delivery {
	t.Helper()
	var deliveryError *mailsetup.DeliveryError
	if !errors.As(err, &deliveryError) {
		t.Fatalf("error %v (%T) isn't a *mailsetup.DeliveryError", err, err)
	}
	return deliveryError.Delivery
}

// parsed is a received message's decoded headers and body.
func parsed(t *testing.T, data []byte) (*mail.Message, string, string) {
	t.Helper()
	message, err := mail.ReadMessage(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("the server got an unparsable message: %v\n%s", err, data)
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(quotedprintable.NewReader(message.Body))
	if err != nil {
		t.Fatal(err)
	}
	return message, subject, strings.ReplaceAll(string(body), "\r\n", "\n")
}

func TestSendsOverSTARTTLSWithPlainAuth(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{})
	message := sampleMessage()
	receipt, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(context.Background(), message)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if receipt.ProviderMessageID != message.MessageID {
		t.Errorf("receipt id = %q, want the Message-ID %q", receipt.ProviderMessageID, message.MessageID)
	}
	_, authSeen, messages := server.snapshot()
	if len(messages) != 1 || strings.Join(authSeen, ",") != "PLAIN" {
		t.Fatalf("server got %d messages, auth %v", len(messages), authSeen)
	}
	got := messages[0]
	if got.from != message.From.Email || strings.Join(got.recipients, ",") != "recruiter@example.org,hiring@example.org" {
		t.Errorf("envelope = %s → %v", got.from, got.recipients)
	}
	headers, subject, body := parsed(t, got.data)
	if subject != message.Subject || body != message.Body {
		t.Errorf("subject %q body %q", subject, body)
	}
	if headers.Header.Get("Message-ID") != "<"+message.MessageID+">" {
		t.Errorf("Message-ID = %q", headers.Header.Get("Message-ID"))
	}
	from, err := headers.Header.AddressList("From")
	if err != nil || len(from) != 1 || from[0].Name != "Jane Doe" || from[0].Address != "jane@example.com" {
		t.Errorf("From = %v (%v)", from, err)
	}
}

func TestImplicitTLSWithLoginAuth(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{implicitTLS: true, authMechanisms: "LOGIN"})
	if _, err := newSender(t, server, config.MailSecurityTLS, smtpmail.Options{}).Send(context.Background(), sampleMessage()); err != nil {
		t.Fatalf("send: %v", err)
	}
	_, authSeen, messages := server.snapshot()
	if len(messages) != 1 || strings.Join(authSeen, ",") != "LOGIN" {
		t.Fatalf("server got %d messages, auth %v", len(messages), authSeen)
	}
}

func TestDotStuffingAndUTF8Survive(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{})
	message := sampleMessage()
	message.Subject = "Café ☕ — a follow-up about the Staff Engineer rôle, with a subject long enough to need several encoded words"
	message.Body = ".starts with a dot\n.\n..two dots\nnaïve résumé 日本語\n" + strings.Repeat("long line ", 30) + "\n"
	if _, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(context.Background(), message); err != nil {
		t.Fatalf("send: %v", err)
	}
	_, _, messages := server.snapshot()
	if len(messages) != 1 {
		t.Fatalf("server got %d messages", len(messages))
	}
	for _, line := range strings.Split(string(messages[0].data), "\r\n") {
		if len(line) > 998 {
			t.Errorf("a line of %d bytes breaks SMTP's limit", len(line))
		}
	}
	_, subject, body := parsed(t, messages[0].data)
	if subject != message.Subject {
		t.Errorf("subject = %q", subject)
	}
	if body != message.Body {
		t.Errorf("body = %q, want %q", body, message.Body)
	}
}

func TestRefusesAServerWithoutSTARTTLS(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{noSTARTTLS: true})
	_, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(context.Background(), sampleMessage())
	if deliveryOf(t, err) != mailsetup.DeliveryNotSentRefused {
		t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
	}
	if _, authSeen, messages := server.snapshot(); len(authSeen) != 0 || len(messages) != 0 {
		t.Errorf("the password or the message crossed an unencrypted connection: auth %v, %d messages", authSeen, len(messages))
	}
}

func TestAuthFailureIsRefusedAndNeverEchoesThePassword(t *testing.T) {
	for _, mechanism := range []string{"PLAIN", "LOGIN"} {
		t.Run(mechanism, func(t *testing.T) {
			server := startFakeServer(t, testUser, testPassword, fakeOptions{authMechanisms: mechanism, echoAuthOnFail: true})
			_, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(context.Background(), sampleMessage())
			if deliveryOf(t, err) != mailsetup.DeliveryNotSentRefused {
				t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
			}
			for _, form := range []string{
				testPassword,
				base64.StdEncoding.EncodeToString([]byte(testPassword)),
				base64.StdEncoding.EncodeToString([]byte("\x00" + testUser + "\x00" + testPassword)),
			} {
				if strings.Contains(err.Error(), form) {
					t.Errorf("error leaks the password (%q): %v", form, err)
				}
			}
			if _, _, messages := server.snapshot(); len(messages) != 0 {
				t.Errorf("sent after a failed login")
			}
		})
	}
}

func TestHeaderInjectionIsRefusedBeforeConnecting(t *testing.T) {
	cases := map[string]func(*mailsetup.Message){
		"subject CRLF":      func(m *mailsetup.Message) { m.Subject = "Hi\r\nBcc: victim@example.net" },
		"subject LF":        func(m *mailsetup.Message) { m.Subject = "Hi\nX-Evil: 1" },
		"subject CR":        func(m *mailsetup.Message) { m.Subject = "Hi\rX-Evil: 1" },
		"subject NUL":       func(m *mailsetup.Message) { m.Subject = "Hi\x00" },
		"from name LF":      func(m *mailsetup.Message) { m.From.Name = "Jane\nBcc: victim@example.net" },
		"from name NUL":     func(m *mailsetup.Message) { m.From.Name = "Jane\x00" },
		"from address CRLF": func(m *mailsetup.Message) { m.From.Email = "jane@example.com\r\nBcc: v@example.net" },
		"to CRLF":           func(m *mailsetup.Message) { m.To = []string{"a@example.org\r\nBcc: v@example.net"} },
		"to NUL":            func(m *mailsetup.Message) { m.To = []string{"a@example.org\x00"} },
		"cc LF":             func(m *mailsetup.Message) { m.Cc = []string{"b@example.org\nBcc: v@example.net"} },
		"message id CRLF":   func(m *mailsetup.Message) { m.MessageID = "x@example.com\r\nBcc: v@example.net" },
		"message id NUL":    func(m *mailsetup.Message) { m.MessageID = "x\x00@example.com" },
		"idempotency LF":    func(m *mailsetup.Message) { m.IdempotencyKey = "k\nX-Evil: 1" },
	}
	server := startFakeServer(t, testUser, testPassword, fakeOptions{})
	sender := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{})
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			message := sampleMessage()
			mutate(&message)
			_, err := sender.Send(context.Background(), message)
			if deliveryOf(t, err) != mailsetup.DeliveryNotSentRefused {
				t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
			}
		})
	}
	if connections, _, _ := server.snapshot(); connections != 0 {
		t.Errorf("the adapter connected %d times for messages it should have refused", connections)
	}
}

func TestTimeoutAfterTheFinalDotIsMaybeSentNotRetried(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{hangAfterDot: true})
	sender := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{DeliveryTimeout: 300 * time.Millisecond})
	_, err := sender.Send(context.Background(), sampleMessage())
	if deliveryOf(t, err) != mailsetup.DeliveryMaybeSent {
		t.Errorf("delivery = %v (%v); a timeout after DATA must never be retried", deliveryOf(t, err), err)
	}
	if _, _, messages := server.snapshot(); len(messages) != 1 {
		t.Errorf("server holds %d messages", len(messages))
	}
}

func TestFailuresBeforeDataAreNotSent(t *testing.T) {
	cases := []struct {
		name    string
		options fakeOptions
		want    mailsetup.Delivery
	}{
		{"temporary refusal of the sender", fakeOptions{mailReply: "451 4.3.0 try later"}, mailsetup.DeliveryNotSentRetry},
		{"permanent refusal of the sender", fakeOptions{mailReply: "553 5.7.1 not your address"}, mailsetup.DeliveryNotSentRefused},
		{"unknown recipient", fakeOptions{refuseRcpt: "hiring@example.org"}, mailsetup.DeliveryNotSentRefused},
		{"refusal after the final dot", fakeOptions{finalReply: "554 5.7.1 looks like spam"}, mailsetup.DeliveryNotSentRefused},
		{"temporary answer after the final dot", fakeOptions{finalReply: "451 4.7.1 greylisted"}, mailsetup.DeliveryMaybeSent},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := startFakeServer(t, testUser, testPassword, testCase.options)
			_, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(context.Background(), sampleMessage())
			if got := deliveryOf(t, err); got != testCase.want {
				t.Errorf("delivery = %v, want %v (%v)", got, testCase.want, err)
			}
		})
	}
}

func TestUnreachableServerIsRetryable(t *testing.T) {
	connection := mailsetup.Connection{
		Host: "127.0.0.1", Port: closedPort(t), Security: config.MailSecuritySTARTTLS,
		Username: testUser, Secret: mailsetup.NewSecret(testPassword),
	}
	sender, err := smtpmail.New(connection, smtpmail.Options{ConnectTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = sender.Send(context.Background(), sampleMessage())
	if deliveryOf(t, err) != mailsetup.DeliveryNotSentRetry {
		t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
	}
}

func TestCancelledContextStopsBeforeSending(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := newSender(t, server, config.MailSecuritySTARTTLS, smtpmail.Options{}).Send(ctx, sampleMessage())
	if deliveryOf(t, err) != mailsetup.DeliveryNotSentRetry {
		t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
	}
	if _, _, messages := server.snapshot(); len(messages) != 0 {
		t.Errorf("sent after cancel")
	}
}

func TestUntrustedCertificateIsRefused(t *testing.T) {
	server := startFakeServer(t, testUser, testPassword, fakeOptions{})
	sender, err := smtpmail.New(connectionTo(server, config.MailSecuritySTARTTLS), smtpmail.Options{ConnectTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = sender.Send(context.Background(), sampleMessage())
	if deliveryOf(t, err) != mailsetup.DeliveryNotSentRefused {
		t.Errorf("delivery = %v (%v)", deliveryOf(t, err), err)
	}
	if _, authSeen, _ := server.snapshot(); len(authSeen) != 0 {
		t.Errorf("the password went to a server whose certificate didn't verify")
	}
}
