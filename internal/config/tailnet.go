// Tailnet knobs: how often a headless server retries joining the tailnet and opening its HTTPS listener, and the agent door's timeouts.
// In the app: first run on a NAS before the owner has logged in, or before HTTPS certificates are on in the tailnet.
// Used by: cmd/hussla (the tailnet join loop).
// Uses: time.
//
// Why retry at all: on a headless server nobody restarts the container after fixing the tailnet's
// settings, so the server keeps trying on its own. The first retry is quick (a toggle in the admin
// console takes seconds); later ones back off so a long-broken tailnet doesn't flood the log.

package config

import "time"

// TailnetRetryFirst is the wait before the first retry after a failed join or listener.
const TailnetRetryFirst = 5 * time.Second

// TailnetRetryMax caps the wait between retries (the wait doubles from TailnetRetryFirst up to it).
const TailnetRetryMax = time.Minute

// AgentFunnelEnv turns on the agent door on Tailscale Funnel when set to "1" (off by default):
// the agent-key API, and nothing else, on the public internet at https://<name>.<tailnet>.ts.net:8443,
// for agents that can't join the tailnet (a scheduled Claude routine in the cloud). The site stays
// tailnet-only. Why opt-in: it is the one internet-facing door (docs/decisions/0016-agent-api-on-funnel.md).
const AgentFunnelEnv = "HUSSLA_AGENT_FUNNEL"

// AgentFunnelPort is the Funnel port of the agent door; Funnel allows only 443, 8443 and 10000,
// and 443 is the tailnet site's.
const AgentFunnelPort = "8443"

// The agent door's server timeouts: the public internet's slow or idle clients are cut off
// instead of holding a connection open. Sized for a config.UploadMaxBytes upload or download on a
// slow link (25 MB at about 1 Mbit/s is under four minutes); a header arrives at once.
const (
	// AgentFunnelReadHeaderTimeout is how long a client has to send its request headers.
	AgentFunnelReadHeaderTimeout = 10 * time.Second
	// AgentFunnelReadTimeout is how long a client has to send a whole request, body included.
	AgentFunnelReadTimeout = 5 * time.Minute
	// AgentFunnelWriteTimeout is how long a request may take from its headers to the last byte of the answer.
	AgentFunnelWriteTimeout = 6 * time.Minute
	// AgentFunnelIdleTimeout is how long a kept-alive connection may sit idle between requests.
	AgentFunnelIdleTimeout = 2 * time.Minute
)
