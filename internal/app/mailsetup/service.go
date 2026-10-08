// Mail setup use-cases: save the owner's provider choice and credential, show it back without the credential, send a test, and hand the outbox a ready sender.
// In the app: Settings → Mail and the first-run wizard (Phase 6) call Save, View and SendTest; the outbox dispatcher calls Sender before each send.
// Used by: internal/httpapi (owner-only routes, Phase 3), internal/app/outbox.
// Uses: store.Store (settings, events), SecretStore, SenderFactory, config.MailProviders.
//
// Secrets: the credential goes only into the SecretStore and comes back out only inside Sender,
// on its way to an adapter. View says whether one is stored, never what it is. Every error and
// log line that could carry provider text passes through redact first, so even a provider that
// echoes the password back can't put it in the outbox row, the API or the log.

package mailsetup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// SettingsKey is where the mail settings (everything but the credential) are stored, as JSON.
const SettingsKey = "mail"

// SecretName is the SecretStore name of the mail credential (password or API key).
const SecretName = "mail.credential"

// MaxFromNameLength caps the sender's display name.
const MaxFromNameLength = 100

// ErrNotConfigured: no mail provider has been set up yet.
var ErrNotConfigured = errors.New("mail isn't set up yet: choose a provider in Settings")

// Settings is the owner's mail choice, minus the credential. Empty Host, Port and Security mean
// the provider's own; "Other SMTP" must name them.
type Settings struct {
	ProviderID  string `json:"providerId"`
	Host        string `json:"host,omitempty"`
	Port        int    `json:"port,omitempty"`
	Security    string `json:"security,omitempty"` // "starttls" or "tls"
	Username    string `json:"username,omitempty"`
	FromAddress string `json:"fromAddress"`
	FromName    string `json:"fromName,omitempty"`
	Region      string `json:"region,omitempty"`
	Domain      string `json:"domain,omitempty"`
}

// View is what the owner sees of the mail setup: the settings and whether a credential is stored.
type View struct {
	Configured bool
	Settings   Settings
	HasSecret  bool
}

// SaveInput is a new mail setup. A nil Secret keeps the stored one (allowed only for the same provider).
type SaveInput struct {
	Settings Settings
	Secret   *Secret
}

// ReadySender is a sender for the current setup, with the identity and cap that go with it.
type ReadySender struct {
	Sender     MailSender
	From       Address
	DailyLimit int // the provider's published cap; 0 when it has none
	secret     Secret
}

// Redact removes this setup's credential from provider text before it is stored or logged.
func (ready ReadySender) Redact(text string) string { return Redact(text, ready.secret) }

// Service runs the mail setup use-cases.
type Service struct {
	store   store.Store
	secrets SecretStore
	factory SenderFactory
	logger  *slog.Logger
	now     func() time.Time
}

// Dependencies are what Service needs; Logger and Now default to slog.Default and time.Now.
type Dependencies struct {
	Store   store.Store
	Secrets SecretStore
	Factory SenderFactory
	Logger  *slog.Logger
	Now     func() time.Time
}

// NewService builds the mail setup use-cases.
func NewService(dependencies Dependencies) *Service {
	service := &Service{
		store: dependencies.Store, secrets: dependencies.Secrets, factory: dependencies.Factory,
		logger: dependencies.Logger, now: dependencies.Now,
	}
	if service.logger == nil {
		service.logger = slog.Default()
	}
	if service.now == nil {
		service.now = time.Now
	}
	return service
}

// View returns the stored setup without the credential.
func (service *Service) View(ctx context.Context) (View, error) {
	current, found, err := service.loadSettings(ctx)
	if err != nil || !found {
		return View{}, err
	}
	hasSecret, err := service.hasSecret(ctx)
	if err != nil {
		return View{}, err
	}
	return View{Configured: true, Settings: current, HasSecret: hasSecret}, nil
}

// Save validates and stores a new setup (owner only; the HTTP layer checks the passkey tap) and logs it, without the credential.
func (service *Service) Save(ctx context.Context, input SaveInput, actor string) (View, error) {
	provider, err := validateSettings(input.Settings)
	if err != nil {
		return View{}, err
	}
	previous, hadSettings, err := service.loadSettings(ctx)
	if err != nil {
		return View{}, err
	}
	if input.Secret != nil {
		if strings.TrimSpace(input.Secret.Reveal()) == "" {
			return View{}, &domain.ValidationError{Field: "secret", Problem: "is empty"}
		}
	} else {
		hasSecret, err := service.hasSecret(ctx)
		if err != nil {
			return View{}, err
		}
		if !hasSecret || !hadSettings || previous.ProviderID != input.Settings.ProviderID {
			return View{}, &domain.ValidationError{Field: "secret", Problem: provider.SecretLabel + " is required for " + provider.Label}
		}
	}
	// The credential first: if the settings write then fails, the next save sends both again.
	if input.Secret != nil {
		if err := service.secrets.Put(ctx, SecretName, *input.Secret); err != nil {
			return View{}, fmt.Errorf("store the mail credential: %w", err)
		}
	}
	encoded, err := json.Marshal(input.Settings)
	if err != nil {
		return View{}, fmt.Errorf("encode mail settings: %w", err)
	}
	err = service.store.Atomically(ctx, func(tx store.Tx) error {
		if err := tx.Settings().Set(ctx, SettingsKey, string(encoded)); err != nil {
			return fmt.Errorf("save mail settings: %w", err)
		}
		detail := "Provider: " + provider.Label + ", from " + input.Settings.FromAddress
		if input.Secret != nil {
			detail += " (new " + strings.ToLower(provider.SecretLabel) + ")"
		}
		event, err := domain.NewEvent("", actor, "Changed mail settings", detail, service.now())
		if err != nil {
			return fmt.Errorf("log mail settings change: %w", err)
		}
		if _, err := tx.Events().Append(ctx, event); err != nil {
			return fmt.Errorf("log mail settings change: %w", err)
		}
		return nil
	})
	if err != nil {
		return View{}, err //nolint:wrapcheck // the work's errors are wrapped where they arise; the store's own failure passes through
	}
	return View{Configured: true, Settings: input.Settings, HasSecret: true}, nil
}

// TestSubject is the subject of the "send test" email.
const TestSubject = config.ProductName + " test email"

// SendTest sends one short email through the current setup to `to` (the owner's own address)
// right away, outside the outbox and its pacing: it is the owner checking their own settings.
// The returned error is safe to show: it names what the provider said, never the credential.
func (service *Service) SendTest(ctx context.Context, to string) (Receipt, error) {
	if !domain.IsPlainAddress(strings.TrimSpace(to)) {
		return Receipt{}, &domain.ValidationError{Field: "to", Problem: "isn't an email address"}
	}
	ready, err := service.sender(ctx)
	if err != nil {
		return Receipt{}, err
	}
	now := domain.NormalizeTime(service.now())
	message := Message{
		From:    ready.From,
		To:      []string{strings.TrimSpace(to)},
		Subject: TestSubject,
		Body: "This is a test from " + config.ProductName + ". If you can read it, follow-ups you approve will go out from " +
			ready.From.Email + ".\n",
		MessageID: "hussla.test." + strings.ReplaceAll(domain.FormatTimestamp(now), ":", "") + "@" + domainOf(ready.From.Email),
	}
	receipt, err := ready.Sender.Send(ctx, message)
	if err != nil {
		reason := ready.Redact(err.Error())
		service.logger.Warn("mail test failed", "delivery", DeliveryOf(err).String(), "reason", reason)
		return Receipt{}, &DeliveryError{Delivery: DeliveryOf(err), Reason: reason}
	}
	service.logger.Info("mail test sent", "to", message.To[0])
	return receipt, nil
}

// Sender builds a sender for the current setup, for the outbox; ErrNotConfigured when there is none.
func (service *Service) Sender(ctx context.Context) (ReadySender, error) {
	return service.sender(ctx)
}

// sender loads settings and credential and builds the adapter.
func (service *Service) sender(ctx context.Context) (ReadySender, error) {
	current, found, err := service.loadSettings(ctx)
	if err != nil {
		return ReadySender{}, err
	}
	if !found {
		return ReadySender{}, ErrNotConfigured
	}
	provider, err := validateSettings(current)
	if err != nil {
		return ReadySender{}, fmt.Errorf("stored mail settings: %w", err)
	}
	secret, err := service.secrets.Get(ctx, SecretName)
	if errors.Is(err, ErrSecretNotFound) {
		return ReadySender{}, ErrNotConfigured
	}
	if err != nil {
		return ReadySender{}, fmt.Errorf("read the mail credential: %w", err)
	}
	connection := connectionFor(provider, current, secret)
	sender, err := service.factory(connection)
	if err != nil {
		return ReadySender{}, fmt.Errorf("set up %s: %w", provider.Label, err)
	}
	from := Address{Email: current.FromAddress, Name: current.FromName}
	return ReadySender{Sender: sender, From: from, DailyLimit: provider.DailyLimit, secret: secret}, nil
}

func (service *Service) loadSettings(ctx context.Context) (Settings, bool, error) {
	var stored string
	err := service.store.View(ctx, func(tx store.Tx) error {
		value, err := tx.Settings().Get(ctx, SettingsKey)
		stored = value
		return err //nolint:wrapcheck // the caller tells storeerr.ErrNotFound apart and wraps the rest
	})
	if errors.Is(err, storeerr.ErrNotFound) {
		return Settings{}, false, nil
	}
	if err != nil {
		return Settings{}, false, fmt.Errorf("read mail settings: %w", err)
	}
	var current Settings
	if err := json.Unmarshal([]byte(stored), &current); err != nil {
		return Settings{}, false, fmt.Errorf("read mail settings: %w", err)
	}
	return current, true, nil
}

func (service *Service) hasSecret(ctx context.Context) (bool, error) {
	_, err := service.secrets.Get(ctx, SecretName)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, ErrSecretNotFound):
		return false, nil
	default:
		return false, fmt.Errorf("read the mail credential: %w", err)
	}
}

// connectionFor fills a connection from the provider's defaults and the owner's overrides.
func connectionFor(provider config.MailProvider, current Settings, secret Secret) Connection {
	connection := Connection{
		Provider: provider, Host: provider.Host, Port: provider.Port, Security: provider.Security,
		BaseURL: provider.BaseURL, Username: current.Username, Domain: current.Domain, Secret: secret,
	}
	if current.Host != "" {
		connection.Host = current.Host
	}
	if current.Port != 0 {
		connection.Port = current.Port
	}
	if security, ok := parseSecurity(current.Security); ok && current.Security != "" {
		connection.Security = security
	}
	for _, region := range provider.Regions {
		if region.ID == current.Region {
			connection.BaseURL = region.BaseURL
		}
	}
	return connection
}

// validateSettings checks a setup against its catalog entry and returns the entry.
func validateSettings(current Settings) (config.MailProvider, error) {
	provider, found := config.FindMailProvider(current.ProviderID)
	if !found {
		return config.MailProvider{}, &domain.ValidationError{Field: "providerId", Problem: `unknown provider "` + current.ProviderID + `"`}
	}
	if !domain.IsPlainAddress(current.FromAddress) {
		return config.MailProvider{}, &domain.ValidationError{Field: "fromAddress", Problem: "isn't an email address"}
	}
	if err := domain.ValidateHeaderText("fromName", current.FromName); err != nil {
		return config.MailProvider{}, err //nolint:wrapcheck // the ValidationError passes through untouched: the HTTP layer maps it to 400
	}
	if len(current.FromName) > MaxFromNameLength {
		return config.MailProvider{}, &domain.ValidationError{Field: "fromName", Problem: "is too long"}
	}
	if _, ok := parseSecurity(current.Security); !ok {
		return config.MailProvider{}, &domain.ValidationError{Field: "security", Problem: `must be "starttls" or "tls"`}
	}
	switch provider.Kind {
	case config.MailProviderSMTP:
		return provider, validateSMTPSettings(provider, current)
	case config.MailProviderAPI:
		return provider, validateAPISettings(provider, current)
	}
	return provider, nil
}

func validateSMTPSettings(provider config.MailProvider, current Settings) error {
	if strings.TrimSpace(current.Username) == "" {
		return &domain.ValidationError{Field: "username", Problem: "is required"}
	}
	if err := domain.ValidateHeaderText("username", current.Username); err != nil {
		return err //nolint:wrapcheck // the ValidationError passes through untouched: the HTTP layer maps it to 400
	}
	host := current.Host
	if host == "" {
		host = provider.Host
	}
	if host == "" {
		return &domain.ValidationError{Field: "host", Problem: "is required for " + provider.Label}
	}
	if !IsHostName(host) {
		return &domain.ValidationError{Field: "host", Problem: "isn't a server name"}
	}
	if current.Port < 0 || current.Port > 65535 {
		return &domain.ValidationError{Field: "port", Problem: "must be 1-65535"}
	}
	return nil
}

func validateAPISettings(provider config.MailProvider, current Settings) error {
	if current.Region != "" {
		known := false
		for _, region := range provider.Regions {
			known = known || region.ID == current.Region
		}
		if !known {
			return &domain.ValidationError{Field: "region", Problem: `unknown region "` + current.Region + `" for ` + provider.Label}
		}
	}
	if provider.NeedsDomain && !IsHostName(current.Domain) {
		return &domain.ValidationError{Field: "domain", Problem: provider.Label + " needs your sending domain, like mg.example.com"}
	}
	return nil
}

// parseSecurity reads a stored security spelling; "" is valid and means the provider's own.
func parseSecurity(text string) (config.MailSecurity, bool) {
	switch text {
	case "", "starttls":
		return config.MailSecuritySTARTTLS, true
	case "tls":
		return config.MailSecurityTLS, true
	}
	return config.MailSecuritySTARTTLS, false
}

// IsHostName accepts a DNS name of letters, digits, hyphens and dots (with a dot inside), or "localhost".
func IsHostName(host string) bool {
	if host == "localhost" {
		return true
	}
	if len(host) == 0 || len(host) > 253 || !strings.Contains(strings.Trim(host, "."), ".") {
		return false
	}
	for _, character := range host {
		isLetterOrDigit := (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')
		if !isLetterOrDigit && character != '-' && character != '.' {
			return false
		}
	}
	return true
}

// Redact removes a credential from text a provider produced (an error, a reply), in case the
// provider echoed it back. Very short secrets are still removed: a leak of any length is a leak.
func Redact(text string, secret Secret) string {
	value := secret.Reveal()
	if value == "" {
		return text
	}
	return strings.ReplaceAll(text, value, redactedText)
}

// MessageIDFor is the deterministic Message-ID of an email at a version (without angle
// brackets): the same email and version always produce the same id.
func MessageIDFor(emailID string, version int, fromAddress string) string {
	return fmt.Sprintf("hussla.%s.v%d@%s", emailID, version, domainOf(fromAddress))
}

// IdempotencyKeyFor is the provider idempotency key of an email at a version: a retry of the
// same approved text is the same request; an edited and re-approved email is a new one.
func IdempotencyKeyFor(emailID string, version int) string {
	return fmt.Sprintf("hussla-%s-v%d", emailID, version)
}

// domainOf is the part after the @ (the address was validated), or "localhost" when there is none.
func domainOf(address string) string {
	_, after, found := strings.Cut(address, "@")
	if !found || after == "" {
		return "localhost"
	}
	return after
}
