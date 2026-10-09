// Tailnet knobs: how often a headless server retries joining the tailnet and opening its HTTPS listener.
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
