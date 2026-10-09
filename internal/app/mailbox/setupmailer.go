// The bridge from Phase 4's mail setup to the outbox's status line and test send.
// In the app: GET /api/mail ("sending from you@example.com through iCloud Mail") and the wizard's and Settings' "Send a test".
// Used by: cmd/hussla (passes SetupMailer as Options.Mailer).
// Uses: mailsetup.Service (View, SendTest), config.MailProviders for the provider's name.

package mailbox

import (
	"context"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
)

// SetupMailer is the Mailer backed by the owner's saved mail setup.
type SetupMailer struct {
	Setup *mailsetup.Service
}

var _ Mailer = SetupMailer{}

// Settings reports the saved setup (never the credential).
func (mailer SetupMailer) Settings(ctx context.Context) (MailSettings, error) {
	view, err := mailer.Setup.View(ctx)
	if err != nil {
		return MailSettings{}, fmt.Errorf("mail settings: %w", err)
	}
	if !view.Configured || !view.HasSecret {
		return MailSettings{}, nil
	}
	provider := view.Settings.ProviderID
	for _, entry := range config.MailProviders() {
		if entry.ID == provider {
			provider = entry.Label
		}
	}
	return MailSettings{Configured: true, From: view.Settings.FromAddress, FromName: view.Settings.FromName, Provider: provider}, nil
}

// SendTest sends the test email to the owner's own sending address.
func (mailer SetupMailer) SendTest(ctx context.Context) (string, error) {
	view, err := mailer.Setup.View(ctx)
	if err != nil {
		return "", fmt.Errorf("mail settings: %w", err)
	}
	if !view.Configured {
		return "", ErrMailNotConfigured
	}
	receipt, err := mailer.Setup.SendTest(ctx, view.Settings.FromAddress)
	if errors.Is(err, mailsetup.ErrNotConfigured) {
		return "", ErrMailNotConfigured
	}
	if err != nil {
		return "", fmt.Errorf("send test: %w", err)
	}
	return receipt.ProviderMessageID, nil
}
