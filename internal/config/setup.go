// First-run knobs: the first-start window, the home-network page, the tailnet refresh, key-expiry warnings and the wizard's steps.
// In the app: the home-network page a NAS shows before Tailscale is set up; the setup wizard; the key-expiry banner.
// Used by: internal/app/auth (the first-run window), internal/app/setup, internal/domain (key expiry), cmd/hussla.
// Uses: time.
//
// Why a window at all: on a headless NAS the setup code sits in a container log a non-technical
// owner never opens. For a short time after the node's owner is first known, on an install that
// has never had a passkey, that Tailscale user may add the first passkey with the home-network
// page's "Make it mine" instead (docs/decisions/0015-first-run-window.md). The window is short so
// a forgotten install doesn't stay open, and it opens once per install: a restart doesn't reopen
// it, and after it the setup code from the log is the way in.

package config

import "time"

// FirstRunWindow is how long the home-network page's "Make it mine" works, from the first time the
// node's owner is adopted, on an install that has never stored a passkey. Once per install.
const FirstRunWindow = 15 * time.Minute

// SetupCodeReissueGap is the least time between two "print a new setup code" requests, so a
// script can't flood the log (or keep rotating the code faster than a person can read it).
const SetupCodeReissueGap = time.Minute

// DefaultHomePort is the home-network page's port in the Docker image (HUSSLA_HOME_PORT). The
// plain binary leaves the page off unless the variable is set.
const DefaultHomePort = "8484"

// HomePageRefresh is how often the home-network page reloads itself while setup is in progress.
const HomePageRefresh = 4 * time.Second

// TailnetRefresh is how often a running server re-reads its tailnet status: a rename, a key
// that expired or a logout shows within this long, and a new login link is asked for.
const TailnetRefresh = 15 * time.Second

// KeyExpiryWarnAhead is how long before the node's Tailscale key expires the app starts warning.
const KeyExpiryWarnAhead = 14 * 24 * time.Hour

// TailscaleAdminDNS is the admin page with the MagicDNS and HTTPS Certificates switches.
const TailscaleAdminDNS = "https://login.tailscale.com/admin/dns"

// TailscaleAdminMachines is the admin page that lists machines (each has "Disable key expiry").
const TailscaleAdminMachines = "https://login.tailscale.com/admin/machines"

// TailscaleDownload is where the phone and laptop apps are.
const TailscaleDownload = "https://tailscale.com/download"

// WizardSteps are the first-run wizard's steps after the passkey, in order. The UI shows them in
// this order; the server accepts only these names.
var WizardSteps = []string{"mail", "import", "agent", "phone", "expiry", "second-passkey"}
