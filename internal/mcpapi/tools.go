// The tool table and the call path: look a tool up, run its use-case as the agent, shape the result.
// In the app: tools/list and tools/call. Each entry is one agent verb over one use-case.
// Used by: server.go (dispatch); the tool files add their entries to catalog().
// Uses: the tracker and mailbox use-cases through callEnv, and internal/app/wire to read arguments.
//
// A failure the model can fix (validation, "the owner wrote that field", not found) is a normal
// result with isError: true and a plain sentence; only an unknown tool or arguments that aren't an
// object are JSON-RPC errors. Nothing in a result or a log line is a secret: errors are reduced to
// their sentinel's message, and arguments are never logged.

package mcpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/domain"
)

// tool is one entry in tools/list and the code behind tools/call.
type tool struct {
	name        string
	title       string
	description string
	schema      map[string]any
	// readOnly tools change nothing; idempotent writes give the same state when repeated.
	readOnly   bool
	idempotent bool
	// route is the HTTP API route this tool mirrors ("PATCH /api/jobs/{jobId}"); tests hold the table against GET /api.
	route string
	run   func(ctx context.Context, env *callEnv, args wire.Object) (any, error)
}

// callEnv is what a tool needs for one call: the use-cases and the agent as their actor.
type callEnv struct {
	tracker *tracker.Service
	mail    *mailbox.Service
	agent   auth.Principal
}

func (env *callEnv) trackerActor() tracker.Actor {
	return tracker.Actor{Name: env.agent.Actor(), Writer: domain.WriterAgent}
}

// mailActor is never the owner here, whatever the key: approving at once is the owner's, and an agent's is ignored.
func (env *callEnv) mailActor() mailbox.Actor {
	return mailbox.Actor{Name: env.agent.Actor(), IsOwner: false}
}

// ToolInfo is a tool's name and the HTTP route it mirrors, for the tests that keep both doors aligned.
type ToolInfo struct {
	Name  string
	Route string
}

// Catalog lists the tools in the order tools/list sends them.
func Catalog() []ToolInfo {
	entries := catalog()
	list := make([]ToolInfo, 0, len(entries))
	for _, entry := range entries {
		list = append(list, ToolInfo{Name: entry.name, Route: entry.route})
	}
	return list
}

// catalog is the whole tool table. A tool absent from it can't be called, whatever name a client sends.
func catalog() []tool {
	var entries []tool
	entries = append(entries, jobTools()...)
	entries = append(entries, companyTools()...)
	entries = append(entries, mailTools()...)
	entries = append(entries, answerTools()...)
	entries = append(entries, pitchTools()...)
	return entries
}

func (s *server) callTool(ctx context.Context, caller auth.Principal, params callParams) (map[string]any, *rpcError) {
	entry, found := s.byName[params.Name]
	if !found {
		return nil, &rpcError{Code: codeInvalidParams, Message: "unknown tool: " + params.Name}
	}
	args := wire.Object{}
	if len(params.Arguments) > 0 && string(params.Arguments) != "null" {
		parsed, err := wire.ParseObject(params.Arguments)
		if err != nil {
			return nil, &rpcError{Code: codeInvalidParams, Message: "arguments must be a JSON object"}
		}
		args = parsed
	}
	env := &callEnv{tracker: s.deps.Tracker, mail: s.deps.Mail, agent: caller}
	out, err := entry.run(ctx, env, args)
	if err != nil {
		message, expected := describe(err)
		if !expected {
			slog.Error("mcp: tool failed", "tool", entry.name, "agent", caller.Name(), "error", err)
		}
		return toolResult(message, true), nil
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		slog.Error("mcp: encode result", "tool", entry.name, "error", err)
		return toolResult("something went wrong on the server; see its log", true), nil
	}
	return toolResult(string(encoded), false), nil
}

func toolResult(text string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isError}
}

// describe turns a use-case error into a sentence an agent can act on. expected is false for the
// ones nobody mapped: they get a generic sentence (and a log line) so no path or driver text leaks.
func describe(err error) (message string, expected bool) {
	var validation *domain.ValidationError
	var ownerFields *domain.OwnerFieldsError
	switch {
	case errors.As(err, &validation):
		return validation.Error(), true
	case errors.As(err, &ownerFields):
		return ownerFields.Error(), true
	case errors.Is(err, domain.ErrChangedSinceRead), errors.Is(err, storeerr.ErrConflict):
		return "changed since you read it: read it again and resend", true
	case errors.Is(err, domain.ErrTransitionNotAllowed):
		return rootMessage(err), true
	case errors.Is(err, domain.ErrOwnerOnly):
		return "only the owner can do this, on the site", true
	case errors.Is(err, storeerr.ErrNotFound):
		return "not found", true
	case errors.Is(err, storeerr.ErrExists):
		return "already exists (use update_job to change it)", true
	case errors.Is(err, mailbox.ErrAgentMayNot), errors.Is(err, mailbox.ErrMailNotConfigured):
		return rootMessage(err), true
	}
	return "something went wrong on the server; see its log", false
}

// rootMessage is the message of the sentinel at the bottom of a wrapped chain (no internal context).
func rootMessage(err error) string {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err.Error()
		}
		err = next
	}
}

// ---- argument readers

func invalid(field, problem string) error {
	return &domain.ValidationError{Field: field, Problem: problem}
}

// text reads a string argument; absent is "" unless required.
func text(args wire.Object, key string, required bool) (string, error) {
	value, present := args[key]
	if !present || string(value) == "null" {
		if required {
			return "", invalid(key, "is required")
		}
		return "", nil
	}
	content, ok := wire.Text(value)
	if !ok {
		return "", invalid(key, "must be text")
	}
	if required && strings.TrimSpace(content) == "" {
		return "", invalid(key, "is required")
	}
	return content, nil
}

// without is args minus the named keys (what is left is a record body for the wire decoders).
func without(args wire.Object, keys ...string) wire.Object {
	rest := wire.Object{}
	for key, value := range args {
		rest[key] = value
	}
	for _, key := range keys {
		delete(rest, key)
	}
	return rest
}

// onlyKeys refuses an argument the tool doesn't have, so a wrong guess ("approve") is said out loud.
func onlyKeys(args wire.Object, allowed ...string) error {
	var unknown []string
	for key := range args {
		known := false
		for _, name := range allowed {
			known = known || name == key
		}
		if !known {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	return invalid(unknown[0], "isn't an argument of this tool; arguments are "+strings.Join(allowed, ", "))
}

func marshalObject(object wire.Object) json.RawMessage { return raw(object) }

// ---- schema helpers

type props map[string]any

func object(required []string, properties props) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func str(description string) props { return props{"type": "string", "description": description} }

func enum(description string, values []string) props {
	return props{"type": "string", "enum": values, "description": description}
}

func strList(description string) props {
	return props{"type": "array", "items": props{"type": "string"}, "description": description}
}
