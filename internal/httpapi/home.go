// The home-network page: http://<NAS address>:8484, the first thing a headless install shows, before anything is set up.
// In the app: Container Manager → Project → Create, then this page in a browser on the home network: Connect to Tailscale, flip HTTPS on if needed, "Make it mine", the address and QR code.
// Used by: cmd/hussla (one listener on HUSSLA_HOME_PORT, all interfaces; off by default for the plain binary, on in the Docker image).
// Uses: setup.Service (Home, StartOver), qr.go. Server-rendered HTML, no script, so the CSP is the strictest one.
//
// It never grants identity and reads no session: everything it shows is safe for anyone on the
// home network. Two checks run on every request, on the connection itself:
//   - the source address must be private (RFC 1918, ULA, link-local, loopback); a page that holds
//     the Tailscale login link must not answer the internet if a router forwards the port;
//   - the Host must be a private IP, a bare name ("nas", "localhost") or a ".local" name, so a
//     public name pointed at a private address (DNS rebinding) is refused before anything runs.
// Behind Docker's port publishing the source can read as the bridge gateway (private) for any
// client, so the install guides publish no port on a cloud server (the cloud compose file has none).

package httpapi

import (
	"bytes"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/config"
)

// NewHome builds the home-network page's handler.
func NewHome(service *setup.Service) http.Handler {
	return &home{setup: service}
}

type home struct {
	setup *setup.Service
}

// homeLabel is one DNS label: what a bare name ("nas") or each part of a ".local" name may be.
var homeLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func (page *home) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Frame-Options", "DENY")
	header.Set("Cache-Control", "no-store")
	if !privateSource(r.RemoteAddr) {
		http.Error(w, "This page answers only the home network.", http.StatusForbidden)
		return
	}
	if !homeHost(r.Host) {
		http.Error(w, "This server doesn't answer to that host name.", http.StatusMisdirectedRequest)
		return
	}
	switch {
	case r.URL.Path == "/healthz" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		writeJSON(w, http.StatusOK, okBody{OK: true})
	case r.URL.Path == "/home.css" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		header.Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write([]byte(homeCSS))
	case r.URL.Path == "/" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		page.render(w, r, "")
	// Browsers ask for it on every page; an empty answer keeps a 404 out of the console.
	case r.URL.Path == "/favicon.ico" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/start-over" && r.Method == http.MethodPost:
		page.startOver(w, r)
	default:
		http.Error(w, "Nothing here. Open / for setup.", http.StatusNotFound)
	}
}

// privateSource reports whether a connection's remote address is on a private network.
func privateSource(remoteAddr string) bool {
	addressPort, err := netip.ParseAddrPort(remoteAddr)
	if err != nil {
		return false
	}
	address := addressPort.Addr().Unmap()
	return address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast()
}

// homeHost reports whether a Host header names this page the way a home network does.
func homeHost(hostHeader string) bool {
	host := strings.ToLower(hostHeader)
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if address, err := netip.ParseAddr(host); err == nil {
		address = address.Unmap()
		return address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast()
	}
	if homeLabel.MatchString(host) {
		return true
	}
	if name, found := strings.CutSuffix(host, ".local"); found && name != "" {
		for _, label := range strings.Split(name, ".") {
			if !homeLabel.MatchString(label) {
				return false
			}
		}
		return true
	}
	return false
}

func (page *home) startOver(w http.ResponseWriter, r *http.Request) {
	// A form post from this page carries this page's own Origin; anything else is another site.
	if r.Header.Get("Origin") != "http://"+r.Host {
		http.Error(w, "Start over only from this page.", http.StatusForbidden)
		return
	}
	if err := page.setup.StartOver(r.Context()); err != nil {
		_, body := statusFor(err)
		page.render(w, r, body.Error)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// homeView is what the template reads.
type homeView struct {
	Product      string
	Tagline      string
	Refresh      int
	Phase        string
	LoginURL     string
	Address      string
	QR           template.HTML
	OwnerLogin   string
	CanStartOver bool
	MakeItMine   string // the full https link with the first-run secret
	MinutesLeft  int
	LinkExpired  bool
	SetupDone    bool
	KeyWarning   string
	Problem      string
	AdminDNS     string
	AdminHosts   string
	Download     string
}

func (page *home) render(w http.ResponseWriter, r *http.Request, problem string) {
	state, err := page.setup.Home(r.Context())
	if err != nil {
		slog.Error("home page", "error", err)
		http.Error(w, "Hussla couldn't read its setup state; its log says why.", http.StatusInternalServerError)
		return
	}
	view := homeView{
		Product: config.ProductName, Tagline: config.ProductTagline, Phase: phaseName(state.Phase),
		LoginURL: state.LoginURL, Address: state.Address, OwnerLogin: state.OwnerLogin, CanStartOver: state.CanStartOver,
		LinkExpired: state.FirstRunExpired && !state.SetupDone, SetupDone: state.SetupDone, Problem: problem,
		AdminDNS: config.TailscaleAdminDNS, AdminHosts: config.TailscaleAdminMachines, Download: config.TailscaleDownload,
	}
	if state.Phase != setup.PhaseRunning || !state.SetupDone {
		view.Refresh = int(config.HomePageRefresh / time.Second)
	}
	if state.Address != "" && state.Phase == setup.PhaseRunning {
		svg, err := qrSVG(state.Address)
		if err == nil {
			view.QR = template.HTML(svg) //nolint:gosec // our own generator's markup; the address inside is escaped
		}
	}
	if state.FirstRunLink != "" && state.Address != "" {
		view.MakeItMine = state.Address + "/setup?link=" + url.QueryEscape(state.FirstRunLink)
		view.MinutesLeft = state.MinutesLeft
	}
	if state.KeyExpiry.Warn {
		view.KeyWarning = "Hussla's Tailscale sign-in expires in " + strconv.Itoa(state.KeyExpiry.DaysLeft) + " days."
		if state.KeyExpiry.Expired {
			view.KeyWarning = "Hussla's Tailscale sign-in has expired."
		}
	}
	var buffer bytes.Buffer
	if err := homeTemplate.Execute(&buffer, view); err != nil {
		slog.Error("home page", "error", err)
		http.Error(w, "Hussla couldn't draw this page; its log says why.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	status := http.StatusOK
	if problem != "" {
		status = http.StatusConflict
	}
	w.WriteHeader(status)
	_, _ = w.Write(buffer.Bytes())
}

func phaseName(phase setup.Phase) string {
	switch phase {
	case setup.PhaseOff:
		return "off"
	case setup.PhaseStarting:
		return "starting"
	case setup.PhaseNeedsLogin:
		return "needs-login"
	case setup.PhaseNeedsHTTPS:
		return "needs-https"
	case setup.PhaseNeedsApproval:
		return "needs-approval"
	case setup.PhaseRunning:
		return "running"
	}
	return "starting"
}

var homeTemplate = template.Must(template.New("home").Parse(homeHTML))

const homeHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{{if .Refresh}}<meta http-equiv="refresh" content="{{.Refresh}}">{{end}}
<title>{{.Product}} setup</title>
<link rel="stylesheet" href="/home.css">
</head>
<body>
<main data-phase="{{.Phase}}">
<h1>{{.Product}}<span class="dot">.</span></h1>
<p class="tagline">{{.Tagline}}</p>
{{if .Problem}}<p class="problem" role="alert">{{.Problem}}</p>{{end}}
{{if .KeyWarning}}<p class="problem" role="alert">{{.KeyWarning}} Open <a href="{{.AdminHosts}}" target="_blank" rel="noopener">Tailscale's Machines page</a>, find this machine, and choose <b>Disable key expiry</b>.</p>{{end}}

{{if eq .Phase "off"}}
<h2>Tailscale is off</h2>
<p>This Hussla runs without Tailscale. On the computer it runs on, open it with <code>hussla open</code>.</p>
{{else if eq .Phase "starting"}}
<h2>Starting Tailscale…</h2>
<p>This page updates by itself. It takes a few seconds.</p>
{{else if eq .Phase "needs-login"}}
<h2>{{if .SetupDone}}Connect again{{else}}Step 1 · Connect to Tailscale{{end}}</h2>
{{if .LoginURL}}
<p><a class="button" id="connect" href="{{.LoginURL}}" target="_blank" rel="noopener">Connect to Tailscale</a></p>
<p>Sign in with the account you use for Tailscale on your phone.{{if not .SetupDone}} <b>Whoever signs in here owns this Hussla</b>, so the person who will use it should click.{{end}} No Tailscale account yet? The same button makes one.</p>
{{else}}
<p>Getting a sign-in link… this page updates by itself.</p>
{{end}}
{{else if eq .Phase "needs-approval"}}
<h2>Waiting for approval</h2>
<p>Your tailnet asks an admin to approve each new machine. Open <a class="button" id="approve" href="{{.AdminHosts}}" target="_blank" rel="noopener">Tailscale's Machines page</a>, find this machine, and choose <b>Approve</b>.</p>
<p>This page notices by itself. Nothing needs restarting.</p>
{{else if eq .Phase "needs-https"}}
<h2>One switch to flip</h2>
<p>Tailscale is connected, but HTTPS is off in your tailnet. Open <a class="button" id="admin-dns" href="{{.AdminDNS}}" target="_blank" rel="noopener">Tailscale DNS settings</a>, turn on <b>MagicDNS</b> if it is off, then turn on <b>HTTPS Certificates</b>.</p>
<p>This page notices by itself. Nothing needs restarting.</p>
{{else}}
<h2>{{if .SetupDone}}Hussla is ready{{else}}Step 2 · Make it yours{{end}}</h2>
<p class="address"><a id="address" href="{{.Address}}">{{.Address}}</a></p>
{{if .QR}}<div class="qr">{{.QR}}</div>{{end}}
<p>Open this address on any device that has Tailscale turned on and is signed in as <b>{{if .OwnerLogin}}{{.OwnerLogin}}{{else}}the owner{{end}}</b>. No Tailscale on this device yet? <a href="{{.Download}}" target="_blank" rel="noopener">Get Tailscale</a>, sign in the same way, and turn it on.</p>
{{if not .SetupDone}}
{{if .MakeItMine}}
<p><a class="button" id="make-it-mine" href="{{.MakeItMine}}">Make it mine</a></p>
<p class="small">This button works for about {{.MinutesLeft}} more minutes, and only for {{.OwnerLogin}}. It adds your passkey (Face ID, Touch ID or your phone).</p>
{{else if .LinkExpired}}
<p class="problem">The setup button has timed out. Restart Hussla (Container Manager → Container → hussla → Action → Restart) and reload this page to get it back for 15 minutes.</p>
{{end}}
{{end}}
{{end}}

{{if and (not .SetupDone) .OwnerLogin}}
<section class="owner">
<p>Owner: <b id="owner">{{.OwnerLogin}}</b></p>
{{if .CanStartOver}}
<form method="post" action="/start-over">
<p>Not you? <button type="submit" id="start-over">Start over</button></p>
<p class="small">Signs Hussla out of that Tailscale account so the right person can connect. Nothing you added is lost.</p>
</form>
{{end}}
</section>
{{end}}
</main>
</body>
</html>
`

const homeCSS = `:root{color-scheme:light dark;--paper:#FBFAF7;--ink:#121212;--line:#D9D5CC;--muted:#555;--red:#C8102E}
@media (prefers-color-scheme:dark){:root{--paper:#121212;--ink:#FBFAF7;--line:#3a3a3a;--muted:#b5b5b5}}
body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.55 Georgia,"Times New Roman",serif}
main{max-width:36rem;margin:0 auto;padding:32px 16px 48px}
h1{font-size:56px;line-height:1;margin:0 0 4px;font-weight:700}
.dot{color:var(--red)}
.tagline{margin:0 0 24px;color:var(--muted);font:14px/1.4 system-ui,sans-serif}
h2{border-top:2px solid var(--ink);padding-top:8px;font-size:28px;margin:24px 0 8px;text-wrap:balance}
p{margin:0 0 16px;text-wrap:pretty}
a{color:inherit}
.button,button{display:inline-block;min-height:44px;padding:10px 20px;box-sizing:border-box;background:var(--ink);color:var(--paper);border:0;border-radius:2px;font:600 16px/24px system-ui,sans-serif;text-decoration:none;cursor:pointer}
.address{font:600 18px/1.4 ui-monospace,Menlo,monospace;word-break:break-all}
.qr svg{width:200px;height:200px;display:block;margin:0 0 16px}
.small{font:14px/1.45 system-ui,sans-serif;color:var(--muted)}
.problem{border-left:4px solid var(--red);padding-left:12px}
.owner{border-top:1px solid var(--line);margin-top:24px;padding-top:16px}
code{font:16px ui-monospace,Menlo,monospace}
`
