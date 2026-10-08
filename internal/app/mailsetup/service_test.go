// Tests for the mail setup use-cases: validation, keeping the credential, the connection handed to the factory, and the test send.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package mailsetup_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

type setup struct {
	service    *mailsetup.Service
	sender     *fakes.MailSender
	secrets    *fakes.SecretStore
	connection mailsetup.Connection
}

func newSetup() *setup {
	s := &setup{sender: &fakes.MailSender{}, secrets: &fakes.SecretStore{}}
	s.service = mailsetup.NewService(mailsetup.Dependencies{
		Store: fakes.New(), Secrets: s.secrets,
		Factory: func(connection mailsetup.Connection) (mailsetup.MailSender, error) {
			s.connection = connection
			return s.sender, nil
		},
	})
	return s
}

func secret(value string) *mailsetup.Secret {
	wrapped := mailsetup.NewSecret(value)
	return &wrapped
}

func icloud() mailsetup.Settings {
	return mailsetup.Settings{ProviderID: "icloud", Username: "jane@icloud.com", FromAddress: "jane@icloud.com", FromName: "Jane Doe"}
}

func TestSaveRefusesBadSettings(t *testing.T) {
	cases := map[string]mailsetup.Settings{
		"unknown provider":        {ProviderID: "aol", Username: "u", FromAddress: "jane@example.com"},
		"bad from address":        {ProviderID: "icloud", Username: "u", FromAddress: "Jane <jane@example.com>"},
		"from name with newline":  {ProviderID: "icloud", Username: "u", FromAddress: "jane@example.com", FromName: "Jane\nBcc: x@example.net"},
		"smtp without username":   {ProviderID: "icloud", FromAddress: "jane@example.com"},
		"username with CR":        {ProviderID: "icloud", Username: "jane\r@example.com", FromAddress: "jane@example.com"},
		"other smtp without host": {ProviderID: "smtp", Username: "u", FromAddress: "jane@example.com"},
		"host with a path":        {ProviderID: "smtp", Username: "u", Host: "mail.example.com/evil", FromAddress: "jane@example.com"},
		"bad port":                {ProviderID: "smtp", Username: "u", Host: "mail.example.com", Port: 70000, FromAddress: "jane@example.com"},
		"bad security":            {ProviderID: "smtp", Username: "u", Host: "mail.example.com", Security: "none", FromAddress: "jane@example.com"},
		"mailgun without domain":  {ProviderID: "mailgun", FromAddress: "jane@example.com"},
		"unknown region":          {ProviderID: "mailgun", Domain: "mg.example.com", Region: "mars", FromAddress: "jane@example.com"},
	}
	for name, settings := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := newSetup().service.Save(context.Background(), mailsetup.SaveInput{Settings: settings, Secret: secret("pw")}, "Jane")
			var validationError *domain.ValidationError
			if !errors.As(err, &validationError) {
				t.Errorf("err = %v, want a ValidationError", err)
			}
		})
	}
}

func TestTheCredentialIsRequiredForANewProviderAndKeptOtherwise(t *testing.T) {
	ctx := context.Background()
	s := newSetup()
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: icloud()}, "Jane"); err == nil {
		t.Fatal("first save without a credential was accepted")
	}
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: icloud(), Secret: secret("  ")}, "Jane"); err == nil {
		t.Fatal("a blank credential was accepted")
	}
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: icloud(), Secret: secret("first")}, "Jane"); err != nil {
		t.Fatal(err)
	}
	renamed := icloud()
	renamed.FromName = "J. Doe"
	view, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: renamed}, "Jane")
	if err != nil || !view.HasSecret || view.Settings.FromName != "J. Doe" {
		t.Fatalf("same-provider save without credential: %+v, %v", view, err)
	}
	if stored, _ := s.secrets.Get(ctx, mailsetup.SecretName); stored.Reveal() != "first" {
		t.Error("the stored credential changed")
	}
	gmail := mailsetup.Settings{ProviderID: "gmail", Username: "jane@gmail.com", FromAddress: "jane@gmail.com"}
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: gmail}, "Jane"); err == nil {
		t.Error("switching provider kept the old provider's password")
	}
}

func TestSendTestUsesTheProviderAndTheOverrides(t *testing.T) {
	ctx := context.Background()
	s := newSetup()
	settings := mailsetup.Settings{
		ProviderID: "zoho", Username: "jane@example.com", FromAddress: "jane@example.com",
		Host: "smtppro.zoho.com", Port: 465, Security: "tls",
	}
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: settings, Secret: secret("pw")}, "Jane"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.service.SendTest(ctx, "jane@example.com"); err != nil {
		t.Fatal(err)
	}
	if s.connection.Host != "smtppro.zoho.com" || s.connection.Port != 465 || s.connection.Security != config.MailSecurityTLS ||
		s.connection.Username != "jane@example.com" || s.connection.Secret.Reveal() != "pw" {
		t.Errorf("connection = %+v", s.connection)
	}
	delivered := s.sender.Delivered()
	if len(delivered) != 1 || delivered[0].Message.To[0] != "jane@example.com" || delivered[0].Message.Subject != mailsetup.TestSubject {
		t.Fatalf("delivered %+v", delivered)
	}
	if !strings.HasSuffix(delivered[0].Message.MessageID, "@example.com") {
		t.Errorf("Message-ID %q", delivered[0].Message.MessageID)
	}
}

func TestRegionPicksTheEndpoint(t *testing.T) {
	ctx := context.Background()
	s := newSetup()
	settings := mailsetup.Settings{ProviderID: "mailgun", Region: "eu", Domain: "mg.example.com", FromAddress: "jane@mg.example.com"}
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: settings, Secret: secret("key")}, "Jane"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.service.Sender(ctx); err != nil {
		t.Fatal(err)
	}
	if s.connection.BaseURL != "https://api.eu.mailgun.net" || s.connection.Domain != "mg.example.com" {
		t.Errorf("connection = %+v", s.connection)
	}
}

func TestSendTestBeforeSetupSaysSo(t *testing.T) {
	if _, err := newSetup().service.SendTest(context.Background(), "jane@example.com"); !errors.Is(err, mailsetup.ErrNotConfigured) {
		t.Errorf("err = %v", err)
	}
}

func TestSendTestReportsTheDelivery(t *testing.T) {
	ctx := context.Background()
	s := newSetup()
	if _, err := s.service.Save(ctx, mailsetup.SaveInput{Settings: icloud(), Secret: secret("pw")}, "Jane"); err != nil {
		t.Fatal(err)
	}
	s.sender.Script(fakes.SendOutcome{Err: mailsetup.NotSentRefused("535 authentication failed")})
	_, err := s.service.SendTest(ctx, "jane@icloud.com")
	if mailsetup.DeliveryOf(err) != mailsetup.DeliveryNotSentRefused || !strings.Contains(err.Error(), "535") {
		t.Errorf("err = %v", err)
	}
}

func TestDeliveryOfAnUnclassifiedErrorIsMaybeSent(t *testing.T) {
	if got := mailsetup.DeliveryOf(errors.New("something odd")); got != mailsetup.DeliveryMaybeSent {
		t.Errorf("unclassified = %v; it must fail safe", got)
	}
	var zero mailsetup.Delivery
	if zero != mailsetup.DeliveryMaybeSent {
		t.Error("the zero Delivery must be the safe one")
	}
}
