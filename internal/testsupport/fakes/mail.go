// In-memory fakes of the mail ports: a scripted MailSender and a SecretStore.
// In the app: nothing at runtime (tests only).
// Used by: tests of internal/app/mailsetup and internal/app/outbox.
// Uses: mailsetup ports.
//
// The sender models the far side: each Send runs the next scripted outcome (deliver, refuse, fail
// after the provider took it, block until released), and what was delivered is kept with the time
// it arrived, so tests assert what the "provider" holds, not how often it was called.

package fakes

import (
	"context"
	"sync"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// SendOutcome is one scripted answer to a Send.
type SendOutcome struct {
	// Err is returned; nil means the provider took the message.
	Err error
	// Delivered is true when the provider holds the message despite Err (a reply lost after DATA).
	Delivered bool
	// Block, when set, makes Send wait for it to close (or ctx) before answering.
	Block chan struct{}
}

// Delivery is a message the fake provider holds and when it got it.
type Delivery struct {
	Message mailsetup.Message
	At      time.Time
}

// MailSender is a scripted mailsetup.MailSender. With no script left it delivers.
type MailSender struct {
	mutex     sync.Mutex
	script    []SendOutcome
	delivered []Delivery
	attempts  int
}

var _ mailsetup.MailSender = (*MailSender)(nil)

// Script appends outcomes for the next sends, in order.
func (sender *MailSender) Script(outcomes ...SendOutcome) {
	sender.mutex.Lock()
	defer sender.mutex.Unlock()
	sender.script = append(sender.script, outcomes...)
}

// Send runs the next scripted outcome.
func (sender *MailSender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return mailsetup.Receipt{}, err
	}
	sender.mutex.Lock()
	sender.attempts++
	outcome := SendOutcome{}
	if len(sender.script) > 0 {
		outcome, sender.script = sender.script[0], sender.script[1:]
	}
	sender.mutex.Unlock()
	if outcome.Block != nil {
		<-outcome.Block
	}
	if outcome.Err == nil || outcome.Delivered {
		sender.mutex.Lock()
		sender.delivered = append(sender.delivered, Delivery{Message: message, At: time.Now()})
		sender.mutex.Unlock()
	}
	if outcome.Err != nil {
		return mailsetup.Receipt{}, outcome.Err
	}
	return mailsetup.Receipt{ProviderMessageID: "fake-" + message.MessageID}, nil
}

// Delivered returns what the provider holds, in arrival order.
func (sender *MailSender) Delivered() []Delivery {
	sender.mutex.Lock()
	defer sender.mutex.Unlock()
	return append([]Delivery(nil), sender.delivered...)
}

// Attempts is how many sends reached the provider at all (delivered or not).
func (sender *MailSender) Attempts() int {
	sender.mutex.Lock()
	defer sender.mutex.Unlock()
	return sender.attempts
}

// SecretStore is an in-memory mailsetup.SecretStore.
type SecretStore struct {
	mutex   sync.Mutex
	secrets map[string]string
}

var _ mailsetup.SecretStore = (*SecretStore)(nil)

// Get returns the secret or mailsetup.ErrSecretNotFound.
func (store *SecretStore) Get(_ context.Context, name string) (mailsetup.Secret, error) {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	value, found := store.secrets[name]
	if !found {
		return mailsetup.Secret{}, mailsetup.ErrSecretNotFound
	}
	return mailsetup.NewSecret(value), nil
}

// Put stores the secret.
func (store *SecretStore) Put(_ context.Context, name string, secret mailsetup.Secret) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	if store.secrets == nil {
		store.secrets = map[string]string{}
	}
	store.secrets[name] = secret.Reveal()
	return nil
}
