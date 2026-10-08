// Tests for the file secret store: round trip, encryption at rest, wrong key, swapped values, and a key that is never replaced.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package secretfile_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/secretfile"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const plaintext = "app-password-synthetic-42"

func open(t *testing.T, dir string) *secretfile.Store {
	t.Helper()
	store, err := secretfile.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestRoundTripAcrossReopenAndEncryptedAtRest(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := open(t, dir).Put(ctx, "mail.credential", mailsetup.NewSecret(plaintext)); err != nil {
		t.Fatal(err)
	}
	got, err := open(t, dir).Get(ctx, "mail.credential")
	if err != nil || got.Reveal() != plaintext {
		t.Fatalf("got %q, %v", got.Reveal(), err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, secretfile.SecretFileName))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(onDisk, []byte(plaintext)) {
		t.Error("the secret is stored in plain text")
	}
	for _, name := range []string{secretfile.KeyFileName, secretfile.SecretFileName} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %v, want 0600", name, info.Mode().Perm())
		}
	}
	if _, err := open(t, dir).Get(ctx, "other"); !errors.Is(err, mailsetup.ErrSecretNotFound) {
		t.Errorf("missing name: %v", err)
	}
}

func TestWrongKeyFails(t *testing.T) {
	ctx := context.Background()
	first, second := t.TempDir(), t.TempDir()
	if err := open(t, first).Put(ctx, "mail.credential", mailsetup.NewSecret(plaintext)); err != nil {
		t.Fatal(err)
	}
	open(t, second) // its own, different key
	data, err := os.ReadFile(filepath.Join(first, secretfile.SecretFileName))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, secretfile.SecretFileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := open(t, second).Get(ctx, "mail.credential")
	if !errors.Is(err, mailsetup.ErrSecretUnreadable) || got.Reveal() != "" {
		t.Errorf("got %q, %v; want ErrSecretUnreadable", got.Reveal(), err)
	}
}

func TestAValueMovedToAnotherNameDoesNotOpen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store := open(t, dir)
	if err := store.Put(ctx, "a", mailsetup.NewSecret(plaintext)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, secretfile.SecretFileName)
	data, _ := os.ReadFile(path)
	var contents struct {
		Version int               `json:"version"`
		Secrets map[string]string `json:"secrets"`
	}
	if err := json.Unmarshal(data, &contents); err != nil {
		t.Fatal(err)
	}
	contents.Secrets["b"] = contents.Secrets["a"]
	data, _ = json.Marshal(contents)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "b"); !errors.Is(err, mailsetup.ErrSecretUnreadable) {
		t.Errorf("moved value opened: %v", err)
	}
}

func TestKeyIsNeverReplaced(t *testing.T) {
	dir := t.TempDir()
	open(t, dir)
	key, _ := os.ReadFile(filepath.Join(dir, secretfile.KeyFileName))
	open(t, dir)
	again, _ := os.ReadFile(filepath.Join(dir, secretfile.KeyFileName))
	if !bytes.Equal(key, again) || len(key) != 32 {
		t.Error("reopening changed the key")
	}
}

func TestRefusesToMintAKeyForOrphanedSecrets(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := open(t, dir).Put(ctx, "mail.credential", mailsetup.NewSecret(plaintext)); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, secretfile.KeyFileName)
	if err := os.Rename(keyPath, keyPath+".elsewhere"); err != nil {
		t.Fatal(err)
	}
	if _, err := secretfile.Open(dir); err == nil {
		t.Fatal("opened with the key missing: a new key would strand the stored secrets")
	}
	if _, err := os.Stat(keyPath); !errors.Is(err, os.ErrNotExist) {
		t.Error("a new key file was written")
	}
}

func TestRefusesAKeyOfTheWrongSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, secretfile.KeyFileName), []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := secretfile.Open(dir); err == nil {
		t.Error("opened with a 5-byte key")
	}
}
