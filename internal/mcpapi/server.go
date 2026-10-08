// The MCP endpoint: the door (Host, Origin, agent key) and the JSON-RPC dispatch behind it.
// In the app: /mcp, the way Claude Code, Claude Desktop and Cursor reach the tracker with an agent key.
// Used by: cmd/hussla (mounts one per listener beside the HTTP API); the tests (through New, with fakes).
// Uses: the same use-cases and the same auth.Service.Agent as internal/httpapi; nothing else.
//
// What is absent is the point. There is no Peers field and no cookie read, so a tailnet identity or a
// session cookie can't be turned into a caller here: the only way in is a valid agent key, and a
// key is an agent, never the owner. Every tool is a thin call into a use-case with that agent as
// the actor, so the rules that keep agents from clearing the owner's fields, approving or sending
// mail live in the use-cases and hold for MCP exactly as for HTTP.
//
// Order is fixed: Host (closes DNS rebinding) → Origin → method → agent key → setup gate → body.

package mcpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/config"
)

// Config is one listener's door.
type Config struct {
	// Hosts are the exact Host values this listener answers (same list as the HTTP API's).
	Hosts []string
	// Secure is true for the tailnet's HTTPS listener (its Origin is https://<host>), false for http://localhost.
	Secure bool
}

// Deps are the use-cases the tools call.
type Deps struct {
	Auth    *auth.Service
	Tracker *tracker.Service
	Mail    *mailbox.Service
}

type server struct {
	config Config
	deps   Deps
	hosts  map[string]bool
	tools  []tool
	byName map[string]*tool
}

// New builds one listener's MCP handler; mount it at config.MCPPath.
func New(config Config, deps Deps) http.Handler {
	s := &server{config: config, deps: deps, hosts: map[string]bool{}, tools: catalog(), byName: map[string]*tool{}}
	for _, host := range config.Hosts {
		s.hosts[strings.ToLower(host)] = true
	}
	for index := range s.tools {
		s.byName[s.tools[index].name] = &s.tools[index]
	}
	return s
}

func (s *server) origin(r *http.Request) string {
	scheme := "http://"
	if s.config.Secure {
		scheme = "https://"
	}
	return scheme + strings.ToLower(r.Host)
}

// ServeHTTP runs the door checks, then the JSON-RPC message.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")

	if !s.hosts[strings.ToLower(r.Host)] {
		writeFault(w, http.StatusMisdirectedRequest, codeInvalidRequest, "this server doesn't answer to that host name", nil)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.origin(r) {
		writeFault(w, http.StatusForbidden, codeInvalidRequest, "requests from another site are refused", nil)
		return
	}
	// 2026-07-28 has no GET stream and no sessions to delete; older clients treat 405 as "no stream".
	if r.Method != http.MethodPost {
		header.Set("Allow", http.MethodPost)
		writeFault(w, http.StatusMethodNotAllowed, codeInvalidRequest, "this endpoint takes POST only", nil)
		return
	}
	caller, ok := s.agent(w, r)
	if !ok {
		return
	}
	s.serveMessage(w, r, caller)
}

// agent proves the caller is an agent with a valid key, or answers 401 (and 403 before an owner exists).
func (s *server) agent(w http.ResponseWriter, r *http.Request) (auth.Principal, bool) {
	scheme, secret, _ := strings.Cut(strings.TrimSpace(strings.Join(r.Header["Authorization"], ",")), " ")
	if !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(secret) == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="hussla"`)
		writeFault(w, http.StatusUnauthorized, codeInvalidRequest, "send an agent key as Authorization: Bearer <key>; the owner makes one in Settings", nil)
		return auth.Principal{}, false
	}
	caller, err := s.deps.Auth.Agent(r.Context(), strings.TrimSpace(secret))
	switch {
	case errors.Is(err, auth.ErrUnauthorized):
		w.Header().Set("WWW-Authenticate", `Bearer realm="hussla", error="invalid_token"`)
		writeFault(w, http.StatusUnauthorized, codeInvalidRequest, "that agent key is wrong or revoked", nil)
		return auth.Principal{}, false
	case err != nil:
		slog.Error("mcp: check agent key", "error", err)
		writeFault(w, http.StatusInternalServerError, codeInvalidRequest, "something went wrong on the server; see its log", nil)
		return auth.Principal{}, false
	}
	// Auth.Agent only ever returns agents; this makes "never the owner here" a local fact too.
	if !caller.IsAgent() {
		writeFault(w, http.StatusForbidden, codeInvalidRequest, "only agent keys work on /mcp", nil)
		return auth.Principal{}, false
	}
	enrolled, err := s.deps.Auth.Enrolled(r.Context())
	if err != nil {
		slog.Error("mcp: check enrollment", "error", err)
		writeFault(w, http.StatusInternalServerError, codeInvalidRequest, "something went wrong on the server; see its log", nil)
		return auth.Principal{}, false
	}
	if !enrolled {
		writeFault(w, http.StatusForbidden, codeInvalidRequest, auth.ErrNotEnrolled.Error(), nil)
		return auth.Principal{}, false
	}
	return caller, true
}

func (s *server) serveMessage(w http.ResponseWriter, r *http.Request, caller auth.Principal) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, config.RequestBodyMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeFault(w, http.StatusRequestEntityTooLarge, codeInvalidRequest, "the body is over the size limit", nil)
			return
		}
		writeFault(w, http.StatusBadRequest, codeParse, "the body couldn't be read", nil)
		return
	}
	var request rpcRequest
	if err := json.Unmarshal(raw, &request); err != nil || request.JSONRPC != "2.0" || request.Method == "" {
		writeFault(w, http.StatusBadRequest, codeInvalidRequest, "send one JSON-RPC 2.0 request or notification (batches aren't supported)", nil)
		return
	}
	if string(request.ID) == "null" {
		writeFault(w, http.StatusBadRequest, codeInvalidRequest, "a request id must be a string or a number", nil)
		return
	}
	if request.isNotification() {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var params callParams
	if len(request.Params) > 0 && string(request.Params) != "null" {
		if err := json.Unmarshal(request.Params, &params); err != nil {
			writeResponse(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: &rpcError{Code: codeInvalidParams, Message: "params must be an object"}})
			return
		}
	}
	if fault := checkEnvelope(r.Header, request, params); fault != nil {
		writeResponse(w, fault.status, rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: &rpcError{Code: fault.code, Message: fault.text, Data: fault.data}})
		return
	}
	modern := params.isModern()
	result, rpcFailure := s.dispatch(r.Context(), caller, request, params, modern)
	if rpcFailure != nil {
		status := http.StatusOK
		if modern && rpcFailure.Code == codeMethodNotFound {
			status = http.StatusNotFound // the modern transport tells "no such method" from a legacy server's 404 by this body
		}
		writeResponse(w, status, rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: rpcFailure})
		return
	}
	if modern {
		result["resultType"] = "complete"
		result["_meta"] = map[string]any{metaServerInfo: serverInfo}
	}
	writeResponse(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result})
}

// dispatch answers one request. The result is a JSON object (modern replies add resultType to it).
func (s *server) dispatch(ctx context.Context, caller auth.Principal, request rpcRequest, params callParams, modern bool) (map[string]any, *rpcError) {
	switch request.Method {
	case "ping":
		return map[string]any{}, nil
	case "initialize":
		if modern {
			return nil, &rpcError{Code: codeMethodNotFound, Message: "initialize isn't used in " + config.MCPProtocolModern + ": send requests with params._meta"}
		}
		version := config.MCPProtocolsLegacy[0]
		if isLegacyVersion(params.ProtocolVersion) {
			version = params.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo": serverInfo, "instructions": config.MCPInstructions,
		}, nil
	case "server/discover":
		if !modern {
			return nil, &rpcError{Code: codeMethodNotFound, Message: "server/discover needs params._meta with the protocol version"}
		}
		return map[string]any{
			"supportedVersions": supportedVersions(), "capabilities": map[string]any{"tools": map[string]any{}},
			"instructions": config.MCPInstructions,
		}, nil
	case "tools/list":
		return map[string]any{"tools": s.toolDefinitions()}, nil
	case "tools/call":
		return s.callTool(ctx, caller, params)
	}
	return nil, &rpcError{Code: codeMethodNotFound, Message: "no such method: " + request.Method}
}

// toolDefinitions is the tool list as tools/list sends it, in catalog order.
func (s *server) toolDefinitions() []map[string]any {
	list := make([]map[string]any, 0, len(s.tools))
	for _, entry := range s.tools {
		list = append(list, map[string]any{
			"name": entry.name, "title": entry.title, "description": entry.description, "inputSchema": entry.schema,
			"annotations": map[string]any{
				"title": entry.title, "readOnlyHint": entry.readOnly, "destructiveHint": false,
				"idempotentHint": entry.readOnly || entry.idempotent, "openWorldHint": false,
			},
		})
	}
	return list
}

func writeResponse(w http.ResponseWriter, status int, body rpcResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("mcp: write response", "error", err)
	}
}

// writeFault answers a refusal that happens before a request id is known (no id in the body).
func writeFault(w http.ResponseWriter, status, code int, message string, data any) {
	writeResponse(w, status, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: code, Message: message, Data: data}})
}
