// Files outside Go packages that the binary carries: the agents' guide served at /api/docs.
// In the app: GET /api/docs.
// Used by: cmd/hussla (the composition root hands it to the HTTP layer).
//
// A root package because go:embed reaches only the embedding package's folder and below, and the
// guide's home is docs/, where people read it.

// Package hussla holds the files the binary embeds from the repository root.
package hussla

import _ "embed"

// AgentsGuide is docs/agents-api.md.
//
//go:embed docs/agents-api.md
var AgentsGuide string
