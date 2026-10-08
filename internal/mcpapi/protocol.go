// MCP on the wire: JSON-RPC envelopes, the two protocol eras, and the errors each era uses.
// In the app: every request to /mcp is decoded and answered through these types.
// Used by: server.go (the door and the dispatch), tools.go (the tool list and call shapes).
//
// Two eras share the endpoint. The modern one (2026-07-28) is stateless: each request carries its
// protocol version and client capabilities in `params._meta`, and the transport headers must agree
// with the body. The legacy ones (2025-03-26 to 2025-11-25) open with `initialize`. Hussla keeps no
// session either way, so a legacy client simply never gets an `Mcp-Session-Id`.

package mcpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/config"
)

// JSON-RPC and MCP error codes this endpoint answers with.
const (
	codeParse           = -32700
	codeInvalidRequest  = -32600
	codeMethodNotFound  = -32601
	codeInvalidParams   = -32602
	codeHeaderMismatch  = -32020
	codeUnsupportedVers = -32022
)

// Keys of the modern per-request metadata (`params._meta`).
const (
	metaProtocolVersion = "io.modelcontextprotocol/protocolVersion"
	metaClientCaps      = "io.modelcontextprotocol/clientCapabilities"
	metaServerInfo      = "io.modelcontextprotocol/serverInfo"
)

// serverInfo is what Hussla reports about itself (display only; a client must not decide anything from it).
var serverInfo = map[string]string{"name": "hussla", "title": config.ProductName, "version": "1"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// isNotification is true for a message with no id (it gets 202 and no body).
func (request rpcRequest) isNotification() bool { return request.ID == nil }

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// callParams are the parts of `params` the dispatcher reads; each method reads its own beyond them.
type callParams struct {
	Meta            map[string]json.RawMessage `json:"_meta"`
	Name            string                     `json:"name"`
	Arguments       json.RawMessage            `json:"arguments"`
	ProtocolVersion string                     `json:"protocolVersion"` // initialize
}

// protocolVersion is the modern `_meta` version, or "" when the request has none (the legacy era).
func (params callParams) protocolVersion() string {
	var version string
	if raw, present := params.Meta[metaProtocolVersion]; present {
		_ = json.Unmarshal(raw, &version)
	}
	return version
}

// isModern is true when the request carries the modern metadata key at all (even with a bad value).
func (params callParams) isModern() bool {
	_, present := params.Meta[metaProtocolVersion]
	return present
}

// supportedVersions lists every revision this endpoint serves, newest first.
func supportedVersions() []string {
	return append([]string{config.MCPProtocolModern}, config.MCPProtocolsLegacy...)
}

func isLegacyVersion(version string) bool {
	for _, known := range config.MCPProtocolsLegacy {
		if version == known {
			return true
		}
	}
	return false
}

// headerFault is a transport-level refusal: an HTTP status and the JSON-RPC error that goes in its body.
type headerFault struct {
	status int
	code   int
	text   string
	data   any
}

// checkEnvelope applies the transport rules for one request: the MCP-Protocol-Version header against
// the body for the modern era, and a known version for the legacy one.
func checkEnvelope(header http.Header, request rpcRequest, params callParams) *headerFault {
	headerVersion := header.Get("MCP-Protocol-Version")
	if !params.isModern() {
		if headerVersion == "" || isLegacyVersion(headerVersion) {
			return nil
		}
		if headerVersion == config.MCPProtocolModern {
			return &headerFault{http.StatusBadRequest, codeInvalidParams, "a " + config.MCPProtocolModern + " request must carry params._meta with its protocol version and client capabilities", nil}
		}
		return unsupported(headerVersion)
	}
	version := params.protocolVersion()
	if version != config.MCPProtocolModern {
		return unsupported(version)
	}
	if _, present := params.Meta[metaClientCaps]; !present {
		return &headerFault{http.StatusBadRequest, codeInvalidParams, "params._meta is missing " + metaClientCaps, nil}
	}
	if headerVersion != version {
		return &headerFault{http.StatusBadRequest, codeHeaderMismatch, "MCP-Protocol-Version does not match params._meta", nil}
	}
	if header.Get("Mcp-Method") != request.Method {
		return &headerFault{http.StatusBadRequest, codeHeaderMismatch, "Mcp-Method does not match the request method", nil}
	}
	if request.Method == "tools/call" && decodeHeaderValue(header.Get("Mcp-Name")) != params.Name {
		return &headerFault{http.StatusBadRequest, codeHeaderMismatch, "Mcp-Name does not match the tool name", nil}
	}
	return nil
}

func unsupported(requested string) *headerFault {
	return &headerFault{
		http.StatusBadRequest, codeUnsupportedVers, "Unsupported protocol version",
		map[string]any{"supported": supportedVersions(), "requested": requested},
	}
}

// decodeHeaderValue undoes the spec's `=?base64?…?=` wrapping for header values that aren't plain ASCII.
func decodeHeaderValue(value string) string {
	const prefix, suffix = "=?base64?", "?="
	if !strings.HasPrefix(value, prefix) || !strings.HasSuffix(value, suffix) || len(value) < len(prefix)+len(suffix) {
		return value
	}
	decoded, err := base64.StdEncoding.DecodeString(value[len(prefix) : len(value)-len(suffix)])
	if err != nil {
		return value
	}
	return string(decoded)
}
