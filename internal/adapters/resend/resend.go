// The Resend adapter: sends one email with POST /emails, carrying an Idempotency-Key so a repeated request is not a second email.
// In the app: the "Resend" provider in the catalog.
// Used by: internal/adapters/mailfactory.
// Uses: internal/adapters/mailhttp (the POST and its outcome rules).
//
// API: https://resend.com/docs/api-reference/emails/send-email. Idempotency keys are kept 24
// hours (https://resend.com/docs/dashboard/emails/idempotency-keys): the same key and payload
// returns the first answer without sending again; the key changes when the email's version does.

package resend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/mail"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// Sender is a mailsetup.MailSender for one Resend API key.
type Sender struct {
	connection mailsetup.Connection
	client     *mailhttp.Client
}

var _ mailsetup.MailSender = (*Sender)(nil)

// New checks the connection and builds a sender.
func New(connection mailsetup.Connection, options mailhttp.Options) (*Sender, error) {
	if err := mailhttp.CheckBaseURL(connection.BaseURL); err != nil {
		return nil, err
	}
	if connection.Secret.IsEmpty() {
		return nil, mailsetup.NotSentRefused("the Resend API key isn't set")
	}
	return &Sender{connection: connection, client: mailhttp.NewClient(options)}, nil
}

type request struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	Cc      []string          `json:"cc,omitempty"`
	Subject string            `json:"subject"`
	Text    string            `json:"text"`
	Headers map[string]string `json:"headers,omitempty"`
}

type reply struct {
	ID string `json:"id"`
}

// Send posts the message; errors are *mailsetup.DeliveryError.
func (sender *Sender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return mailsetup.Receipt{}, err
	}
	body, err := json.Marshal(request{
		From:    (&mail.Address{Name: message.From.Name, Address: message.From.Email}).String(),
		To:      message.To,
		Cc:      message.Cc,
		Subject: message.Subject,
		Text:    message.Body,
		Headers: map[string]string{"X-Hussla-Message-Id": message.MessageID},
	})
	if err != nil {
		return mailsetup.Receipt{}, mailsetup.NotSentRefused("encode the request: " + err.Error())
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+sender.connection.Secret.Reveal())
	header.Set("Content-Type", "application/json")
	header.Set("User-Agent", "hussla")
	if message.IdempotencyKey != "" {
		header.Set("Idempotency-Key", message.IdempotencyKey)
	}
	response, err := sender.client.Post(ctx, sender.connection.BaseURL+"/emails", header, body, sender.connection.Secret)
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	var parsed reply
	_ = json.Unmarshal(response.Body, &parsed) // a 2xx is a send even if its reply is unreadable
	return mailsetup.Receipt{ProviderMessageID: parsed.ID}, nil
}
