// Tests that every catalog provider builds the right kind of sender.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package mailfactory_test

import (
	"testing"

	"github.com/bretperry/hussla/internal/adapters/mailfactory"
	"github.com/bretperry/hussla/internal/adapters/smtpmail"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
)

func TestEveryProviderBuildsASender(t *testing.T) {
	for _, provider := range config.MailProviders() {
		connection := mailsetup.Connection{
			Provider: provider, Host: provider.Host, Port: provider.Port, Security: provider.Security,
			BaseURL: provider.BaseURL, Username: "jane@example.com", Domain: "mg.example.com",
			Secret: mailsetup.NewSecret("synthetic"),
		}
		if connection.Host == "" {
			connection.Host = "smtp.example.com"
		}
		sender, err := mailfactory.New(connection)
		if err != nil || sender == nil {
			t.Errorf("%s: %v", provider.ID, err)
			continue
		}
		_, isSMTP := sender.(*smtpmail.Sender)
		if isSMTP != (provider.Kind == config.MailProviderSMTP) {
			t.Errorf("%s built %T", provider.ID, sender)
		}
	}
}

func TestAMissingCredentialIsRefused(t *testing.T) {
	provider, _ := config.FindMailProvider("resend")
	sender, err := mailfactory.New(mailsetup.Connection{Provider: provider, BaseURL: provider.BaseURL})
	if err == nil || sender != nil {
		t.Errorf("built %v, %v", sender, err)
	}
}
