// The secret store on disk: credentials encrypted with AES-256-GCM under a key file in the data directory.
// In the app: holds the mail password or API key the owner pastes once in Settings; read only when an email is handed to the provider.
// Used by: the composition root (Phase 3) as the mailsetup.SecretStore.
// Uses: crypto/aes, crypto/cipher, crypto/rand; files <DATA_DIR>/secret.key and <DATA_DIR>/secrets.json.
//
// What this protects: the key file sits beside the data, so encryption protects a leaked backup
// of the database or a log, not someone holding the whole volume (say so in Settings and the
// install guide). Each value is sealed with its name as additional data, so a value moved to
// another name fails to open. Writes go to a temp file, are synced, then renamed over the old
// one, so a kill mid-write leaves the previous file whole. An existing key file is never
// replaced: a new key would make every stored secret unreadable, which is deletion by another name.

package secretfile

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/bretperry/hussla/internal/app/mailsetup"
)

// File names inside the data directory.
const (
	KeyFileName    = "secret.key"
	SecretFileName = "secrets.json"
)

// keySize is AES-256's key length in bytes.
const keySize = 32

// fileVersion is the secrets file's format; a reader refuses one it doesn't know.
const fileVersion = 1

// secretFile is the JSON shape on disk: name → base64(nonce || ciphertext+tag).
type secretFile struct {
	Version int               `json:"version"`
	Secrets map[string]string `json:"secrets"`
}

// Store is the file-backed mailsetup.SecretStore. Safe for concurrent use within one process
// (one process per data dir is the composition root's flock).
type Store struct {
	mutex      sync.Mutex
	aead       cipher.AEAD
	secretPath string
}

var _ mailsetup.SecretStore = (*Store)(nil)

// Open loads the key from dataDir, creating it (0600) on first use. It refuses to create a key
// when a secrets file already exists without one: those secrets need their own key back.
func Open(dataDir string) (*Store, error) {
	keyPath := filepath.Join(dataDir, KeyFileName)
	secretPath := filepath.Join(dataDir, SecretFileName)
	key, err := os.ReadFile(keyPath)
	if errors.Is(err, fs.ErrNotExist) {
		if _, statErr := os.Stat(secretPath); statErr == nil {
			return nil, fmt.Errorf("%s exists but %s is missing: restore the key file from a backup, or move %s aside and enter the mail credential again",
				secretPath, keyPath, SecretFileName)
		}
		key, err = createKey(keyPath)
	}
	if err != nil {
		return nil, fmt.Errorf("secret key: %w", err)
	}
	if len(key) != keySize {
		return nil, fmt.Errorf("secret key %s is %d bytes, want %d: it isn't a key this program wrote", keyPath, len(key), keySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("secret key: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secret key: %w", err)
	}
	return &Store{aead: aead, secretPath: secretPath}, nil
}

// createKey writes 32 random bytes to a new file, failing if one appeared meanwhile.
func createKey(keyPath string) ([]byte, error) {
	key := make([]byte, keySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate: %w", err)
	}
	if err := writeFileDurably(keyPath, key, true); err != nil {
		return nil, err
	}
	return key, nil
}

// Get decrypts the secret stored under name.
func (store *Store) Get(_ context.Context, name string) (mailsetup.Secret, error) {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	contents, err := store.read()
	if err != nil {
		return mailsetup.Secret{}, err
	}
	sealed, found := contents.Secrets[name]
	if !found {
		return mailsetup.Secret{}, mailsetup.ErrSecretNotFound
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	nonceSize := store.aead.NonceSize()
	if err != nil || len(raw) < nonceSize {
		return mailsetup.Secret{}, mailsetup.ErrSecretUnreadable
	}
	plain, err := store.aead.Open(nil, raw[:nonceSize], raw[nonceSize:], []byte(name))
	if err != nil {
		return mailsetup.Secret{}, mailsetup.ErrSecretUnreadable
	}
	return mailsetup.NewSecret(string(plain)), nil
}

// Put encrypts the secret under name with a fresh random nonce and replaces the file durably.
func (store *Store) Put(_ context.Context, name string, secret mailsetup.Secret) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	contents, err := store.read()
	if err != nil {
		return err
	}
	nonce := make([]byte, store.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("secret nonce: %w", err)
	}
	sealed := store.aead.Seal(nonce, nonce, []byte(secret.Reveal()), []byte(name))
	contents.Secrets[name] = base64.StdEncoding.EncodeToString(sealed)
	encoded, err := json.MarshalIndent(contents, "", "  ")
	if err != nil {
		return fmt.Errorf("encode secrets: %w", err)
	}
	return writeFileDurably(store.secretPath, encoded, false)
}

// read loads the secrets file; a missing file is an empty store.
func (store *Store) read() (secretFile, error) {
	empty := secretFile{Version: fileVersion, Secrets: map[string]string{}}
	data, err := os.ReadFile(store.secretPath)
	if errors.Is(err, fs.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return secretFile{}, fmt.Errorf("read secrets: %w", err)
	}
	var contents secretFile
	if err := json.Unmarshal(data, &contents); err != nil || contents.Version != fileVersion {
		return secretFile{}, fmt.Errorf("%s: %w", store.secretPath, mailsetup.ErrSecretUnreadable)
	}
	if contents.Secrets == nil {
		contents.Secrets = map[string]string{}
	}
	return contents, nil
}

// writeFileDurably writes data to path (0600) through a synced temp file and a rename, then syncs
// the directory, so a kill at any moment leaves either the old file or the new one. With
// exclusive, an existing path is an error instead of being replaced.
func writeFileDurably(path string, data []byte, exclusive bool) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }() // a no-op after the rename; cleans up after a failure
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if exclusive {
		// A hard link fails if path exists, so a key another start wrote meanwhile is never replaced.
		if err := os.Link(tempPath, path); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	} else if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	syncDirectory(directory)
	return nil
}

// syncDirectory makes a rename in it durable. Best effort: Windows can't open a directory and some
// filesystems refuse to sync one; the file itself is already synced either way.
func syncDirectory(directory string) {
	handle, err := os.Open(directory)
	if err != nil {
		return
	}
	_ = handle.Sync()
	_ = handle.Close()
}
