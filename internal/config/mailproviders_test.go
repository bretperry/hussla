// Tests for the provider catalog's shape: every entry is complete enough for the setup screen and the adapters.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package config_test

import (
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/config"
)

func TestEveryProviderIsComplete(t *testing.T) {
	seen := map[string]bool{}
	for _, provider := range config.MailProviders() {
		if provider.ID == "" || seen[provider.ID] || provider.Label == "" || provider.SecretLabel == "" || len(provider.HelpSteps) == 0 {
			t.Errorf("%q: missing id, label, secret label or steps, or a repeated id", provider.ID)
		}
		seen[provider.ID] = true
		if provider.ID != config.MailProviderOtherSMTP && !strings.HasPrefix(provider.DocsURL, "https://") {
			t.Errorf("%s: no documentation link", provider.ID)
		}
		switch provider.Kind {
		case config.MailProviderSMTP:
			if provider.Port <= 0 || (provider.Host == "" && provider.ID != config.MailProviderOtherSMTP) {
				t.Errorf("%s: SMTP entry without host or port", provider.ID)
			}
		case config.MailProviderAPI:
			if !strings.HasPrefix(provider.BaseURL, "https://") {
				t.Errorf("%s: API entry without an https endpoint", provider.ID)
			}
			for _, region := range provider.Regions {
				if !strings.HasPrefix(region.BaseURL, "https://") || region.ID == "" {
					t.Errorf("%s: region %+v", provider.ID, region)
				}
			}
		}
	}
	for _, id := range []string{"icloud", "gmail", "outlook", "yahoo", "fastmail", "zoho", "smtp", "resend", "postmark", "sendgrid", "mailgun"} {
		if !seen[id] {
			t.Errorf("catalog lacks %s", id)
		}
	}
}

func TestOutlookSaysPasswordLoginIsGoneForPersonalAccounts(t *testing.T) {
	outlook, found := config.FindMailProvider("outlook")
	if !found || !strings.Contains(outlook.Warning, "Outlook.com") || !strings.Contains(strings.Join(outlook.HelpSteps, " "), "won't work") {
		t.Errorf("the Outlook entry must say personal accounts can't use a password: %+v", outlook)
	}
}

func TestICloudMatchesApplesSettings(t *testing.T) {
	icloud, _ := config.FindMailProvider("icloud")
	if icloud.Host != "smtp.mail.me.com" || icloud.Port != 587 || icloud.Security != config.MailSecuritySTARTTLS {
		t.Errorf("iCloud = %s:%d %v", icloud.Host, icloud.Port, icloud.Security)
	}
}

func TestTheCatalogCantBeEditedByACaller(t *testing.T) {
	config.MailProviders()[0].HelpSteps[0] = "changed"
	if config.MailProviders()[0].HelpSteps[0] == "changed" {
		t.Error("a caller changed the catalog for everyone")
	}
}
