// The sign-in token file: `hussla open` writes a one-time token into the data directory; the server reads and removes it.
// In the app: a laptop without Tailscale; the owner runs `hussla open` and the browser lands signed in.
// Used by: cmd/hussla (`hussla open` calls Write; the server's auth.Service reads through Store).
// Uses: <DATA_DIR>/signin-token, mode 0600.
//
// The file is the proof: only someone who can write the data directory can make one, which is the
// same person who owns the data. The server refuses a file that group or others can read (a token
// someone else could have copied) or that isn't a plain file (a symlink planted elsewhere).

package signinfile

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
)

// FileName is the token file's name in the data directory.
const FileName = "signin-token"

type fileContents struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Store reads and removes the token file.
type Store struct {
	path string
}

// New uses <dataDir>/signin-token.
func New(dataDir string) *Store { return &Store{path: filepath.Join(dataDir, FileName)} }

// Read returns the token, or auth.ErrNoSignInToken when there is none or it isn't safe to trust.
func (store *Store) Read(_ context.Context) (auth.SignInToken, error) {
	info, err := os.Lstat(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return auth.SignInToken{}, auth.ErrNoSignInToken
	}
	if err != nil {
		return auth.SignInToken{}, fmt.Errorf("sign-in token: %w", err)
	}
	// Windows has no Unix permission bits; there the data directory's own ACL is what protects it.
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return auth.SignInToken{}, auth.ErrNoSignInToken
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		return auth.SignInToken{}, fmt.Errorf("sign-in token: %w", err)
	}
	var contents fileContents
	if err := json.Unmarshal(raw, &contents); err != nil || contents.Token == "" {
		return auth.SignInToken{}, auth.ErrNoSignInToken
	}
	return auth.SignInToken{Secret: contents.Token, ExpiresAt: contents.ExpiresAt}, nil
}

// Remove deletes the token file.
func (store *Store) Remove(_ context.Context) error {
	if err := os.Remove(store.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove sign-in token: %w", err)
	}
	return nil
}

// Write makes a fresh token valid for config.SignInTokenLifetime and returns it. It replaces any
// older one (only the newest link works).
func Write(dataDir string, now time.Time) (string, error) {
	buffer := make([]byte, 32)
	_, _ = rand.Read(buffer)
	token := base64.RawURLEncoding.EncodeToString(buffer)
	encoded, err := json.Marshal(fileContents{Token: token, ExpiresAt: now.Add(config.SignInTokenLifetime).UTC()})
	if err != nil {
		return "", fmt.Errorf("encode sign-in token: %w", err)
	}
	temp, err := os.CreateTemp(dataDir, ".signin-*") // CreateTemp makes it 0600
	if err != nil {
		return "", fmt.Errorf("write sign-in token: %w", err)
	}
	defer func() { _ = os.Remove(temp.Name()) }()
	if _, err := temp.Write(encoded); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("write sign-in token: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("write sign-in token: %w", err)
	}
	if err := os.Rename(temp.Name(), filepath.Join(dataDir, FileName)); err != nil {
		return "", fmt.Errorf("place sign-in token: %w", err)
	}
	return token, nil
}
