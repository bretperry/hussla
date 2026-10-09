// The door: Host and Origin allow-lists, who the caller is, the setup gate, and the per-route role checks.
// In the app: every request, before any route runs. This file is the security model's "identity comes
// from the connection, never from headers", "a key is never upgraded", and "owner-only actions need a
// passkey tap" in code; internal/httpapi/auth_matrix_test.go proves each check by its absence.
// Used by: server.go (ServeHTTP and the route wrappers).
//
// Order matters and is fixed: Host (closes DNS rebinding) → Origin (a foreign page can't drive the
// owner's browser) → identity (bearer key first and final; else WhoIs or the session cookie) →
// setup gate (nothing but the setup screen until there is an owner) → the route's role check.

package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/bretperry/hussla/internal/app/auth"
)

type principalKey struct{}

// ServeHTTP runs the door checks, then the route.
func (server *api) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Frame-Options", "DENY")
	if server.scheme == "https" {
		header.Set("Strict-Transport-Security", "max-age=31536000")
	}

	if !server.hosts[strings.ToLower(r.Host)] {
		writeError(w, http.StatusMisdirectedRequest, errorBody{Error: "this server doesn't answer to that host name"})
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != server.origin(r) {
		writeError(w, http.StatusForbidden, errorBody{Error: "requests from another site are refused"})
		return
	}
	caller, err := server.identify(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	// The agent door has no owner and no anonymous routes: an agent key or nothing.
	if server.config.Listener == ListenerFunnel && !caller.IsAgent() {
		w.Header().Set("WWW-Authenticate", `Bearer realm="hussla"`)
		writeError(w, http.StatusUnauthorized, errorBody{Error: "send an agent key as Authorization: Bearer <key>; the owner makes one in Settings"})
		return
	}
	// A browser always sends Origin on a write; a write with neither an Origin nor an agent key is
	// a non-browser client riding on the owner's identity (or a very old browser): refused.
	if !caller.IsAgent() && !isSafeMethod(r.Method) && origin == "" {
		writeError(w, http.StatusForbidden, errorBody{Error: "a browser write must carry an Origin header; scripts use an agent key"})
		return
	}
	server.mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, caller)))
}

func isSafeMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// origin is the one Origin this listener accepts for a request's (already allowed) Host.
func (server *api) origin(r *http.Request) string {
	return server.scheme + "://" + strings.ToLower(r.Host)
}

// relyingParty is the passkey site for this request: the host name without port, and the origin.
func (server *api) relyingParty(r *http.Request) auth.RelyingParty {
	host := strings.ToLower(r.Host)
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return auth.RelyingParty{ID: host, Origin: server.origin(r)}
}

// identify proves who is calling. A bearer key decides alone: valid is that agent, anything else
// is 401, never a fall-through to the owner's identity. Without one, the listener's own proof:
// WhoIs on the tailnet, the session cookie locally. No header names an identity.
func (server *api) identify(r *http.Request) (auth.Principal, error) {
	ctx := r.Context()
	if authorization, present := r.Header["Authorization"]; present {
		value := strings.TrimSpace(strings.Join(authorization, ","))
		scheme, secret, _ := strings.Cut(value, " ")
		if !strings.EqualFold(scheme, "Bearer") {
			return auth.Principal{}, auth.ErrUnauthorized
		}
		return server.deps.Auth.Agent(ctx, strings.TrimSpace(secret)) //nolint:wrapcheck // auth's sentinels map to 401
	}
	switch server.config.Listener {
	case ListenerTailnet:
		if server.config.Peers == nil {
			return auth.Principal{}, nil
		}
		peer, err := server.config.Peers.WhoIs(ctx, r.RemoteAddr)
		if errors.Is(err, auth.ErrUnknownPeer) {
			return auth.Principal{}, nil
		}
		if err != nil {
			return auth.Principal{}, err //nolint:wrapcheck // a tailnet failure is a 500
		}
		return server.deps.Auth.TailnetPrincipal(ctx, peer) //nolint:wrapcheck // passes through
	case ListenerLocal:
		cookie, err := r.Cookie(SessionCookie)
		if err != nil {
			return auth.Principal{}, nil
		}
		caller, err := server.deps.Auth.SessionPrincipal(ctx, cookie.Value)
		if errors.Is(err, auth.ErrUnauthorized) {
			return auth.Principal{}, nil
		}
		return caller, err //nolint:wrapcheck // passes through
	case ListenerFunnel:
		// The internet: no WhoIs, no cookie. Only the bearer key above can name a caller.
		return auth.Principal{}, nil
	}
	return auth.Principal{}, nil
}

func callerOf(r *http.Request) auth.Principal {
	caller, _ := r.Context().Value(principalKey{}).(auth.Principal)
	return caller
}

// routeHandler is a route body; an error it returns is mapped by fail.
type routeHandler func(w http.ResponseWriter, r *http.Request, caller auth.Principal) error

// gate refuses everything but the setup screen until an owner is enrolled.
func (server *api) gate(r *http.Request) error {
	enrolled, err := server.deps.Auth.Enrolled(r.Context())
	if err != nil {
		return err //nolint:wrapcheck // a 500
	}
	if !enrolled {
		return auth.ErrNotEnrolled
	}
	return nil
}

// requireMember lets the owner and agents through; a non-owner tailnet user is refused, and no proof is 401.
func requireMember(caller auth.Principal) error {
	switch caller.Role() {
	case auth.RoleOwner, auth.RoleAgent:
		return nil
	case auth.RolePeer:
		return auth.ErrNotOwner
	case auth.RoleNone:
		return auth.ErrUnauthorized
	}
	return auth.ErrUnauthorized
}

// requireOwner lets only the owner through: an agent key is never upgraded, whoever sends it.
func requireOwner(caller auth.Principal) error {
	switch caller.Role() {
	case auth.RoleOwner:
		return nil
	case auth.RoleAgent, auth.RolePeer:
		return auth.ErrNotOwner
	case auth.RoleNone:
		return auth.ErrUnauthorized
	}
	return auth.ErrUnauthorized
}

func (server *api) wrap(checks func(r *http.Request, caller auth.Principal) error, route routeHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller := callerOf(r)
		if err := checks(r, caller); err != nil {
			fail(w, r, err)
			return
		}
		if err := route(w, r, caller); err != nil {
			fail(w, r, err)
		}
	})
}

// notOnFunnel is what the owner and anyone wrappers serve on the agent door, whatever funnelRoutes
// says: the route doesn't exist there.
var notOnFunnel = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, errorBody{Error: "no such endpoint; GET /api lists them"})
})

// anyone: the setup screen and sign-in; the route itself decides.
func (server *api) anyone(route routeHandler) http.Handler {
	if server.config.Listener == ListenerFunnel {
		return notOnFunnel
	}
	return server.wrap(func(*http.Request, auth.Principal) error { return nil }, route)
}

// member: the owner or an agent, after enrollment.
func (server *api) member(route routeHandler) http.Handler {
	return server.wrap(func(r *http.Request, caller auth.Principal) error {
		if err := requireMember(caller); err != nil {
			return err
		}
		return server.gate(r)
	}, route)
}

// owner: the owner only, after enrollment (reads and the passkey ceremony itself).
func (server *api) owner(route routeHandler) http.Handler {
	if server.config.Listener == ListenerFunnel {
		return notOnFunnel
	}
	return server.wrap(func(r *http.Request, caller auth.Principal) error {
		if err := requireOwner(caller); err != nil {
			return err
		}
		return server.gate(r)
	}, route)
}

// ownerStepUp: the owner only, with a step-up token from a passkey tap for exactly this method and path.
func (server *api) ownerStepUp(route routeHandler) http.Handler {
	if server.config.Listener == ListenerFunnel {
		return notOnFunnel
	}
	return server.wrap(func(r *http.Request, caller auth.Principal) error {
		if err := requireOwner(caller); err != nil {
			return err
		}
		if err := server.gate(r); err != nil {
			return err
		}
		return server.deps.Auth.ConsumeStepUp(caller, stepUpPurpose(r), r.Header.Get(StepUpHeader))
	}, route)
}

// stepUpPurpose is what a step-up token must have been granted for: "POST /api/emails/e1/approve".
func stepUpPurpose(r *http.Request) string {
	return r.Method + " " + r.URL.Path
}
