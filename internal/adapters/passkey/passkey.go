// The passkey adapter: WebAuthn registration and assertion with github.com/go-webauthn/webauthn, behind auth.Ceremony.
// In the app: the Face ID / Touch ID / phone prompt for setup and before every owner-only action.
// Used by: cmd/hussla (wired into auth.Service); the HTTP tests, with the virtual authenticator in internal/testsupport.
// Uses: go-webauthn (pinned exactly in go.mod).
//
// Every ceremony is checked against one relying party, built per request from the allowed host:
// the RP ID is the host name and the only accepted origin is that host's own origin, so an
// assertion made for another site, or on another address of this one, doesn't verify. User
// presence is always required (the library checks the UP flag); user verification is "preferred",
// so a plain security key works and Face ID still asks for the face. A credential whose sign count
// goes backwards (a cloned authenticator) is refused.

package passkey

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
)

// Ceremony implements auth.Ceremony.
type Ceremony struct{}

// errCloned: the authenticator's counter went backwards, a sign of a copied credential.
var errCloned = errors.New("the passkey's counter went backwards; it may have been copied")

// user adapts the owner to the library's User.
type user struct {
	owner       auth.PasskeyUser
	credentials []webauthn.Credential
}

func (u user) WebAuthnID() []byte                         { return u.owner.Handle }
func (u user) WebAuthnName() string                       { return u.owner.Name }
func (u user) WebAuthnDisplayName() string                { return u.owner.Name }
func (u user) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func relyingParty(rp auth.RelyingParty) (*webauthn.WebAuthn, error) {
	relying, err := webauthn.New(&webauthn.Config{RPID: rp.ID, RPDisplayName: config.ProductName, RPOrigins: []string{rp.Origin}})
	if err != nil {
		return nil, fmt.Errorf("passkey site %s: %w", rp.ID, err)
	}
	return relying, nil
}

func decodeCredentials(stored []auth.StoredPasskey) ([]webauthn.Credential, error) {
	credentials := make([]webauthn.Credential, 0, len(stored))
	for _, passkey := range stored {
		var credential webauthn.Credential
		if err := json.Unmarshal(passkey.Credential, &credential); err != nil {
			return nil, fmt.Errorf("stored passkey %s is damaged: %w", passkey.ID, err)
		}
		credentials = append(credentials, credential)
	}
	return credentials, nil
}

func encode(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode passkey data: %w", err)
	}
	return encoded, nil
}

// BeginRegistration returns navigator.credentials.create options (excluding passkeys already registered).
func (Ceremony) BeginRegistration(rp auth.RelyingParty, owner auth.PasskeyUser, existing []auth.StoredPasskey) ([]byte, []byte, error) {
	relying, err := relyingParty(rp)
	if err != nil {
		return nil, nil, err
	}
	credentials, err := decodeCredentials(existing)
	if err != nil {
		return nil, nil, err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(credentials))
	for index := range credentials {
		exclusions = append(exclusions, credentials[index].Descriptor())
	}
	creation, session, err := relying.BeginRegistration(user{owner: owner, credentials: credentials},
		webauthn.WithExclusions(exclusions),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementPreferred),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("begin registration: %w", err)
	}
	options, err := encode(creation)
	if err != nil {
		return nil, nil, err
	}
	blob, err := encode(session)
	return options, blob, err
}

// FinishRegistration verifies the new credential.
func (Ceremony) FinishRegistration(rp auth.RelyingParty, owner auth.PasskeyUser, session, response []byte) (string, []byte, error) {
	relying, err := relyingParty(rp)
	if err != nil {
		return "", nil, err
	}
	var data webauthn.SessionData
	if err := json.Unmarshal(session, &data); err != nil {
		return "", nil, fmt.Errorf("passkey session: %w", err)
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(response)
	if err != nil {
		return "", nil, fmt.Errorf("read new passkey: %w", err)
	}
	credential, err := relying.CreateCredential(user{owner: owner}, data, parsed)
	if err != nil {
		return "", nil, fmt.Errorf("verify new passkey: %w", err)
	}
	blob, err := encode(credential)
	if err != nil {
		return "", nil, err
	}
	return base64.RawURLEncoding.EncodeToString(credential.ID), blob, nil
}

// BeginAssertion returns navigator.credentials.get options for the given passkeys.
func (Ceremony) BeginAssertion(rp auth.RelyingParty, owner auth.PasskeyUser, passkeys []auth.StoredPasskey) ([]byte, []byte, error) {
	relying, err := relyingParty(rp)
	if err != nil {
		return nil, nil, err
	}
	credentials, err := decodeCredentials(passkeys)
	if err != nil {
		return nil, nil, err
	}
	assertion, session, err := relying.BeginLogin(user{owner: owner, credentials: credentials}, webauthn.WithUserVerification(protocol.VerificationPreferred))
	if err != nil {
		return nil, nil, fmt.Errorf("begin passkey check: %w", err)
	}
	options, err := encode(assertion)
	if err != nil {
		return nil, nil, err
	}
	blob, err := encode(session)
	return options, blob, err
}

// FinishAssertion verifies a tap and returns the credential with its new sign count.
func (Ceremony) FinishAssertion(rp auth.RelyingParty, owner auth.PasskeyUser, passkeys []auth.StoredPasskey, session, response []byte) (string, []byte, error) {
	relying, err := relyingParty(rp)
	if err != nil {
		return "", nil, err
	}
	credentials, err := decodeCredentials(passkeys)
	if err != nil {
		return "", nil, err
	}
	var data webauthn.SessionData
	if err := json.Unmarshal(session, &data); err != nil {
		return "", nil, fmt.Errorf("passkey session: %w", err)
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
	if err != nil {
		return "", nil, fmt.Errorf("read passkey answer: %w", err)
	}
	credential, err := relying.ValidateLogin(user{owner: owner, credentials: credentials}, data, parsed)
	if err != nil {
		return "", nil, fmt.Errorf("verify passkey answer: %w", err)
	}
	if credential.Authenticator.CloneWarning {
		return "", nil, errCloned
	}
	blob, err := encode(credential)
	if err != nil {
		return "", nil, err
	}
	return base64.RawURLEncoding.EncodeToString(credential.ID), blob, nil
}
