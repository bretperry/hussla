// The Postmark adapter: sends one email with POST /email and the server token.
// In the app: the "Postmark" provider in the catalog.
// Used by: internal/adapters/mailfactory.
// Uses: internal/adapters/mailhttp (the POST and its outcome rules).
//
// API: https://postmarkapp.com/developer/api/email-api. Postmark documents no idempotency key,
// so a request cut off after it was written is "may have been sent" and waits for the owner.

package postmark

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"strings"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// MessageStream is Postmark's default transactional stream; follow-ups are one-to-one mail, not broadcasts.
const MessageStream = "outbound"

// Sender is a mailsetup.MailSender for one Postmark server token.
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
		return nil, mailsetup.NotSentRefused("the Postmark server token isn't set")
	}
	return &Sender{connection: connection, client: mailhttp.NewClient(options)}, nil
}

type header struct {
	Name  string `json:"Name"`
	Value string `json:"Value"`
}

type request struct {
	From          string   `json:"From"`
	To            string   `json:"To"`
	Cc            string   `json:"Cc,omitempty"`
	Subject       string   `json:"Subject"`
	TextBody      string   `json:"TextBody"`
	Headers       []header `json:"Headers,omitempty"`
	MessageStream string   `json:"MessageStream"`
}

type reply struct {
	ErrorCode int    `json:"ErrorCode"`
	Message   string `json:"Message"`
	MessageID string `json:"MessageID"`
}

// Send posts the message; errors are *mailsetup.DeliveryError.
func (sender *Sender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return mailsetup.Receipt{}, err
	}
	body, err := json.Marshal(request{
		From:          (&mail.Address{Name: message.From.Name, Address: message.From.Email}).String(),
		To:            strings.Join(message.To, ", "),
		Cc:            strings.Join(message.Cc, ", "),
		Subject:       message.Subject,
		TextBody:      message.Body,
		Headers:       []header{{Name: "X-Hussla-Message-Id", Value: message.MessageID}},
		MessageStream: MessageStream,
	})
	if err != nil {
		return mailsetup.Receipt{}, mailsetup.NotSentRefused("encode the request: " + err.Error())
	}
	requestHeader := http.Header{}
	requestHeader.Set("X-Postmark-Server-Token", sender.connection.Secret.Reveal())
	requestHeader.Set("Content-Type", "application/json")
	requestHeader.Set("Accept", "application/json")
	requestHeader.Set("User-Agent", "hussla")
	response, err := sender.client.Post(ctx, sender.connection.BaseURL+"/email", requestHeader, body, sender.connection.Secret)
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	var parsed reply
	_ = json.Unmarshal(response.Body, &parsed) // a 2xx is a send even if its reply is unreadable
	if parsed.ErrorCode != 0 {
		// Postmark reports refusals as 422; a 2xx carrying an error code is treated the same way, never retried.
		return mailsetup.Receipt{}, mailsetup.NotSentRefused(mailsetup.Redact(fmt.Sprintf("Postmark error %d: %s", parsed.ErrorCode, parsed.Message), sender.connection.Secret))
	}
	return mailsetup.Receipt{ProviderMessageID: parsed.MessageID}, nil
}
