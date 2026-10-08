// The settings port: small named values the owner or the setup wizard chose.
// In the app: Settings, the search configuration the agents read, the mail window.
// Used by: use-cases (Phases 3-4) and the seed import, through store.Tx.
//
// Values are opaque text (usually JSON); the use-case that owns a key parses it. Secrets don't
// belong here: Phase 4's secret store keeps them encrypted.

package settings

import "context"

// Well-known keys.
const (
	// KeySearchConfig holds the search configuration the seed file's "config" object carries, as JSON.
	KeySearchConfig = "search-config"
)

// Repository stores settings by key. Errors: storeerr.ErrNotFound.
type Repository interface {
	// Get returns the value, or storeerr.ErrNotFound.
	Get(ctx context.Context, key string) (string, error)
	// Set stores the value, replacing any earlier one.
	Set(ctx context.Context, key, value string) error
	// All returns every setting.
	All(ctx context.Context) (map[string]string, error)
}
