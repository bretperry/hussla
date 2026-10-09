// The release this binary was built from: "v0.1.1" on a tagged build, "dev" otherwise.
// In the app: the muted "Hussla v0.1.1" line on Settings (GET /api/me's `version`), and each migration's record.
// Used by: cmd/hussla (migrations), the HTTP layer's /api/me.
// Set by: -ldflags "-X github.com/bretperry/hussla/internal/config.Version=…" in the Dockerfile and scripts/release-binaries.sh.

package config

// Version is a var, not a const, because the linker's -X can only set a string var.
var Version = "dev"
