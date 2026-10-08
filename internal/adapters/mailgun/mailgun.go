// The Mailgun adapter: sends one email with POST /v3/{domain}/messages, a multipart form and basic auth.
// In the app: the "Mailgun" provider in the catalog (US or EU region).
// Used by: internal/adapters/mailfactory.
// Uses: internal/adapters/mailhttp (the POST and its outcome rules), mime/multipart.
//
// API: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages.
// The username is the literal "api" and the password the API key. Custom headers go in "h:" fields.
// Mailgun documents no idempotency key for sends.

package mailgun

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/url"
	"strings"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// Sender is a mailsetup.MailSender for one Mailgun sending domain and key.
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
		return nil, mailsetup.NotSentRefused("the Mailgun API key isn't set")
	}
	if connection.Domain == "" || strings.ContainsAny(connection.Domain, "/?#% ") {
		return nil, mailsetup.NotSentRefused("the Mailgun sending domain isn't set")
	}
	return &Sender{connection: connection, client: mailhttp.NewClient(options)}, nil
}

type reply struct {
	ID string `json:"id"`
}

// Send posts the message; errors are *mailsetup.DeliveryError.
func (sender *Sender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return mailsetup.Receipt{}, err
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	fields := [][2]string{
		{"from", (&mail.Address{Name: message.From.Name, Address: message.From.Email}).String()},
		{"to", strings.Join(message.To, ",")},
		{"subject", message.Subject},
		{"text", message.Body},
		{"h:X-Hussla-Message-Id", message.MessageID},
	}
	if len(message.Cc) > 0 {
		fields = append(fields, [2]string{"cc", strings.Join(message.Cc, ",")})
	}
	for _, field := range fields {
		if err := form.WriteField(field[0], field[1]); err != nil {
			return mailsetup.Receipt{}, mailsetup.NotSentRefused("encode the request: " + err.Error())
		}
	}
	if err := form.Close(); err != nil {
		return mailsetup.Receipt{}, mailsetup.NotSentRefused("encode the request: " + err.Error())
	}
	header := http.Header{}
	credentials := base64.StdEncoding.EncodeToString([]byte("api:" + sender.connection.Secret.Reveal()))
	header.Set("Authorization", "Basic "+credentials)
	header.Set("Content-Type", form.FormDataContentType())
	header.Set("User-Agent", "hussla")
	endpoint := sender.connection.BaseURL + "/v3/" + url.PathEscape(sender.connection.Domain) + "/messages"
	response, err := sender.client.Post(ctx, endpoint, header, body.Bytes(), sender.connection.Secret)
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	var parsed reply
	_ = json.Unmarshal(response.Body, &parsed) // a 2xx is a send even if its reply is unreadable
	return mailsetup.Receipt{ProviderMessageID: strings.Trim(parsed.ID, "<>")}, nil
}
