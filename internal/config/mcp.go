// MCP endpoint knobs: where it lives and which protocol revisions it speaks.
// In the app: the /mcp endpoint agents connect to with the same bearer key as the HTTP API.
// Used by: internal/mcpapi (the handler), cmd/hussla (mounting the path), docs/agents-api.md.
//
// Why two eras: the 2026-07-28 revision is stateless (no `initialize`, no session id) and the
// revisions before it open with an `initialize` handshake. Claude Code and Cursor still speak the
// older one, so the endpoint serves both and picks per request (see docs/decisions/0014-mcp-endpoint.md).

package config

// MCPPath is the one path the MCP endpoint answers on.
const MCPPath = "/mcp"

// MCPProtocolModern is the stateless revision: every request carries its version in `_meta`.
const MCPProtocolModern = "2026-07-28"

// MCPProtocolsLegacy are the handshake revisions served, newest first. A client that asks for one
// of them in `initialize` gets it back; any other ask gets the newest.
var MCPProtocolsLegacy = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

// MCPFindJobsLimit caps what find_jobs returns, so a big tracker doesn't flood an agent's context.
const MCPFindJobsLimit = 100

// MCPInstructions is the guidance an MCP client shows the model when it connects.
const MCPInstructions = "Hussla is the owner's job-search tracker. Read before you write: find_jobs and get_job, " +
	"get_search_config (if paused is true, only read) and list_answers for form questions. Writes are patches: send only what changed. " +
	"You can draft emails but never send them; the owner approves each one on the site. " +
	"If a field says the owner last wrote it, leave it alone."
