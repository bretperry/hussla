// The sender factory: picks and builds the mail adapter for the owner's chosen provider.
// In the app: runs before every send (the outbox) and every "send test", so a settings change applies to the next email.
// Used by: the composition root (Phase 3) passes New as the mailsetup.SenderFactory.
// Uses: the smtpmail, resend, postmark, sendgrid and mailgun adapters.

package mailfactory

import (
	"github.com/bretperry/hussla/internal/adapters/mailgun"
	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/adapters/postmark"
	"github.com/bretperry/hussla/internal/adapters/resend"
	"github.com/bretperry/hussla/internal/adapters/sendgrid"
	"github.com/bretperry/hussla/internal/adapters/smtpmail"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
)

// New builds the sender for a connection: SMTP for every SMTP provider, else the provider's own API adapter.
func New(connection mailsetup.Connection) (mailsetup.MailSender, error) {
	switch connection.Provider.Kind {
	case config.MailProviderSMTP:
		return nonNil(smtpmail.New(connection, smtpmail.Options{}))
	case config.MailProviderAPI:
		return newAPISender(connection)
	}
	return nil, mailsetup.NotSentRefused("unknown provider kind")
}

func newAPISender(connection mailsetup.Connection) (mailsetup.MailSender, error) {
	options := mailhttp.Options{}
	var sender mailsetup.MailSender
	var err error
	// Each branch assigns through the interface only on success, so a failed New never hands back a typed nil.
	switch connection.Provider.ID {
	case "resend":
		sender, err = nonNil(resend.New(connection, options))
	case "postmark":
		sender, err = nonNil(postmark.New(connection, options))
	case "sendgrid":
		sender, err = nonNil(sendgrid.New(connection, options))
	case "mailgun":
		sender, err = nonNil(mailgun.New(connection, options))
	default:
		return nil, mailsetup.NotSentRefused("no adapter for provider " + connection.Provider.ID)
	}
	return sender, err
}

// nonNil turns an adapter constructor's (pointer, error) into (interface, error) without a typed nil.
func nonNil[S mailsetup.MailSender](sender S, err error) (mailsetup.MailSender, error) {
	if err != nil {
		return nil, err
	}
	return sender, nil
}

var _ mailsetup.SenderFactory = New
