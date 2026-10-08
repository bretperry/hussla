// The SendGrid adapter: sends one email with POST /v3/mail/send and an API key.
// In the app: the "SendGrid" provider in the catalog (global or EU subuser region).
// Used by: internal/adapters/mailfactory.
// Uses: internal/adapters/mailhttp (the POST and its outcome rules).
//
// API: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send. Success is 202
// with an empty body; the message id comes back in the X-Message-Id header. SendGrid documents no
// idempotency key. It refuses a personalization that names the same address twice, so a Cc that
// repeats a To is dropped (that person gets the email once either way).

package sendgrid

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// Sender is a mailsetup.MailSender for one SendGrid API key.
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
		return nil, mailsetup.NotSentRefused("the SendGrid API key isn't set")
	}
	return &Sender{connection: connection, client: mailhttp.NewClient(options)}, nil
}

type address struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type personalization struct {
	To []address `json:"to"`
	Cc []address `json:"cc,omitempty"`
}

type content struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type request struct {
	Personalizations []personalization `json:"personalizations"`
	From             address           `json:"from"`
	Subject          string            `json:"subject"`
	Content          []content         `json:"content"`
	Headers          map[string]string `json:"headers,omitempty"`
}

// Send posts the message; errors are *mailsetup.DeliveryError.
func (sender *Sender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return mailsetup.Receipt{}, err
	}
	seen := map[string]bool{}
	recipients := personalization{}
	for _, email := range message.To {
		seen[strings.ToLower(email)] = true
		recipients.To = append(recipients.To, address{Email: email})
	}
	for _, email := range message.Cc {
		if !seen[strings.ToLower(email)] {
			recipients.Cc = append(recipients.Cc, address{Email: email})
		}
	}
	body, err := json.Marshal(request{
		Personalizations: []personalization{recipients},
		From:             address{Email: message.From.Email, Name: message.From.Name},
		Subject:          message.Subject,
		Content:          []content{{Type: "text/plain", Value: message.Body}},
		Headers:          map[string]string{"X-Hussla-Message-Id": message.MessageID},
	})
	if err != nil {
		return mailsetup.Receipt{}, mailsetup.NotSentRefused("encode the request: " + err.Error())
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+sender.connection.Secret.Reveal())
	header.Set("Content-Type", "application/json")
	header.Set("User-Agent", "hussla")
	response, err := sender.client.Post(ctx, sender.connection.BaseURL+"/v3/mail/send", header, body, sender.connection.Secret)
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	return mailsetup.Receipt{ProviderMessageID: response.Header.Get("X-Message-Id")}, nil
}
