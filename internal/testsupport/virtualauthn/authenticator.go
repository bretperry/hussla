// A virtual WebAuthn authenticator: answers navigator.credentials.create and .get with a real P-256 key, as a browser would send them.
// In the app: nothing at runtime (tests only); it stands in for Face ID, Touch ID or a security key.
// Used by: the HTTP and passkey tests (setup, step-up, the auth matrix).
// Uses: crypto/ecdsa and a few hand-written CBOR bytes; no WebAuthn library, so it can't share a bug with the one under test.
//
// It speaks the wire format only: it reads the options JSON the server sent, and returns the
// credential JSON the browser would POST back ("none" attestation, ES256). A test can sign for
// another origin, or with a stale counter, to prove the server refuses it.

package virtualauthn

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

// Authenticator holds one credential (made by Register) and its signature counter.
type Authenticator struct {
	key          *ecdsa.PrivateKey
	credentialID []byte
	userHandle   []byte
	rpID         string
	// Counter is the signature counter; Assert increments it first. A test may set it back.
	Counter uint32
}

// New makes an authenticator with a fresh key and credential id.
func New() *Authenticator {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err) // crypto/rand doesn't fail
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &Authenticator{key: key, credentialID: id}
}

var b64 = base64.RawURLEncoding

// creationOptions is the part of PublicKeyCredentialCreationOptions this needs.
type creationOptions struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RP        struct {
			ID string `json:"id"`
		} `json:"rp"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"publicKey"`
}

type requestOptions struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RPID      string `json:"rpId"`
	} `json:"publicKey"`
}

// Register answers creation options (the server's `options` JSON) as a browser on `origin` would.
func (a *Authenticator) Register(options []byte, origin string) ([]byte, error) {
	var parsed creationOptions
	if err := json.Unmarshal(options, &parsed); err != nil {
		return nil, fmt.Errorf("creation options: %w", err)
	}
	if parsed.PublicKey.Challenge == "" || parsed.PublicKey.RP.ID == "" {
		return nil, errors.New("creation options have no challenge or rp.id")
	}
	handle, err := b64.DecodeString(parsed.PublicKey.User.ID)
	if err != nil {
		return nil, fmt.Errorf("user.id: %w", err)
	}
	a.userHandle, a.rpID = handle, parsed.PublicKey.RP.ID
	clientData := clientDataJSON("webauthn.create", parsed.PublicKey.Challenge, origin)

	authData := a.authenticatorData(a.rpID, flagUserPresent|flagUserVerified|flagAttestedData)
	authData = append(authData, make([]byte, 16)...) // AAGUID: all zero, as "none" attestation sends
	authData = binary.BigEndian.AppendUint16(authData, uint16(len(a.credentialID)))
	authData = append(authData, a.credentialID...)
	authData = append(authData, a.coseKey()...)

	// {"fmt": "none", "attStmt": {}, "authData": <bytes>}
	attestation := []byte{0xa3}
	attestation = appendText(attestation, "fmt")
	attestation = appendText(attestation, "none")
	attestation = appendText(attestation, "attStmt")
	attestation = append(attestation, 0xa0)
	attestation = appendText(attestation, "authData")
	attestation = appendBytes(attestation, authData)

	return marshal(map[string]any{
		"id": b64.EncodeToString(a.credentialID), "rawId": b64.EncodeToString(a.credentialID), "type": "public-key",
		"response": map[string]string{"clientDataJSON": b64.EncodeToString(clientData), "attestationObject": b64.EncodeToString(attestation)},
	})
}

// Assert answers request options with a signed tap, as a browser on `origin` would.
func (a *Authenticator) Assert(options []byte, origin string) ([]byte, error) {
	var parsed requestOptions
	if err := json.Unmarshal(options, &parsed); err != nil {
		return nil, fmt.Errorf("request options: %w", err)
	}
	if parsed.PublicKey.Challenge == "" {
		return nil, errors.New("request options have no challenge")
	}
	rpID := parsed.PublicKey.RPID
	if rpID == "" {
		rpID = a.rpID
	}
	a.Counter++
	clientData := clientDataJSON("webauthn.get", parsed.PublicKey.Challenge, origin)
	authData := a.authenticatorData(rpID, flagUserPresent|flagUserVerified)
	clientHash := sha256.Sum256(clientData)
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	return marshal(map[string]any{
		"id": b64.EncodeToString(a.credentialID), "rawId": b64.EncodeToString(a.credentialID), "type": "public-key",
		"response": map[string]string{
			"clientDataJSON": b64.EncodeToString(clientData), "authenticatorData": b64.EncodeToString(authData),
			"signature": b64.EncodeToString(signature), "userHandle": b64.EncodeToString(a.userHandle),
		},
	})
}

const (
	flagUserPresent  = 0x01
	flagUserVerified = 0x04
	flagAttestedData = 0x40
)

func (a *Authenticator) authenticatorData(rpID string, flags byte) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	data := append([]byte{}, rpHash[:]...)
	data = append(data, flags)
	return binary.BigEndian.AppendUint32(data, a.Counter)
}

// coseKey is the public key as a COSE_Key: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
func (a *Authenticator) coseKey() []byte {
	x := make([]byte, 32)
	y := make([]byte, 32)
	a.key.X.FillBytes(x)
	a.key.Y.FillBytes(y)
	key := []byte{0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21}
	key = appendBytes(key, x)
	key = append(key, 0x22)
	return appendBytes(key, y)
}

func clientDataJSON(kind, challenge, origin string) []byte {
	encoded, _ := json.Marshal(map[string]any{"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return encoded
}

// appendHeader writes a CBOR major type with its length.
func appendHeader(out []byte, major byte, length int) []byte {
	switch {
	case length < 24:
		return append(out, major<<5|byte(length))
	case length < 256:
		return append(out, major<<5|24, byte(length))
	default:
		return binary.BigEndian.AppendUint16(append(out, major<<5|25), uint16(length))
	}
}

func appendBytes(out, value []byte) []byte { return append(appendHeader(out, 2, len(value)), value...) }

func appendText(out []byte, value string) []byte {
	return append(appendHeader(out, 3, len(value)), value...)
}

func marshal(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode credential: %w", err)
	}
	return encoded, nil
}
