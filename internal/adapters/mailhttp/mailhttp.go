// Shared plumbing for the HTTP mail APIs: one POST, and what its outcome means for "never send twice".
// In the app: every email sent through Resend, Postmark, SendGrid or Mailgun goes through Post.
// Used by: internal/adapters/{resend,postmark,sendgrid,mailgun}.
// Uses: net/http, net/http/httptrace (to know whether the request reached the wire).
//
// The rule: a failure before the request's headers were written sent nothing and is retried; a
// failure after (a timeout, a dropped connection, an unexpected 5xx) may have been taken, so the
// email waits for the owner. 429 and 503 are the provider saying "not now" (nothing taken):
// retried. Other 4xx are refusals the owner must fix. Redirects are not followed: Go forwards
// custom headers (Postmark's token) to wherever a redirect points.

package mailhttp

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
)

// maxResponseBytes caps how much of a provider's reply is read; a success or an error message is far smaller.
const maxResponseBytes = 64 << 10

// maxReasonLength caps the provider text kept in a failure reason.
const maxReasonLength = 300

// Options tune the HTTP adapters; the zero value is production.
type Options struct {
	// ConnectTimeout bounds dialing and the TLS handshake; 0 means config.MailConnectTimeout.
	ConnectTimeout time.Duration
	// DeliveryTimeout bounds the whole request and reply; 0 means config.MailDeliveryTimeout.
	DeliveryTimeout time.Duration
}

// Client posts to one provider's API.
type Client struct {
	http    *http.Client
	options Options
}

// NewClient builds a client that never follows redirects.
func NewClient(options Options) *Client {
	if options.ConnectTimeout <= 0 {
		options.ConnectTimeout = config.MailConnectTimeout
	}
	if options.DeliveryTimeout <= 0 {
		options.DeliveryTimeout = config.MailDeliveryTimeout
	}
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: options.ConnectTimeout}).DialContext,
		TLSHandshakeTimeout: options.ConnectTimeout,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:   true,
	}
	return &Client{
		http: &http.Client{
			Transport:     transport,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		options: options,
	}
}

// CheckBaseURL accepts https, or http only to this machine (the tests' fake servers): an API key
// never crosses the network in the clear.
func CheckBaseURL(base string) error {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return mailsetup.NotSentRefused("the provider's address isn't a URL")
	}
	host := parsed.Hostname()
	isLoopback := host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !isLoopback) {
		return mailsetup.NotSentRefused("the provider's address must use https")
	}
	return nil
}

// Response is a provider's reply to a request that succeeded (2xx).
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Post sends one request and returns the 2xx reply, or a *mailsetup.DeliveryError with the
// credential removed from any provider text. The context can stop it only before it is sent.
func (client *Client) Post(ctx context.Context, endpoint string, header http.Header, body []byte, secret mailsetup.Secret) (Response, error) {
	if err := ctx.Err(); err != nil {
		return Response{}, mailsetup.NotSentRetry("stopped before sending")
	}
	// Once started, the request runs to its answer or the delivery timeout: cancelling it midway
	// would turn a delivered email into an unknown one.
	requestContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), client.options.DeliveryTimeout)
	defer cancel()
	var wroteHeaders atomic.Bool
	trace := &httptrace.ClientTrace{WroteHeaders: func() { wroteHeaders.Store(true) }}
	request, err := http.NewRequestWithContext(httptrace.WithClientTrace(requestContext, trace), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Response{}, mailsetup.NotSentRefused("build the request: " + redact(err.Error(), secret))
	}
	request.Header = header
	response, err := client.http.Do(request)
	if err != nil {
		reason := redact(err.Error(), secret)
		if !wroteHeaders.Load() {
			return Response{}, mailsetup.NotSentRetry("couldn't reach the provider: " + reason)
		}
		return Response{}, mailsetup.MaybeSent("the provider didn't answer: " + reason)
	}
	defer func() { _ = response.Body.Close() }()
	reply, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		// The provider took it. A reply cut off while reading doesn't change that.
		return Response{Status: response.StatusCode, Header: response.Header, Body: reply}, nil
	}
	if readErr != nil {
		reply = nil
	}
	return Response{}, classifyStatus(response.StatusCode, redact(excerpt(reply), secret))
}

// classifyStatus turns a non-2xx status into what it means for the email.
func classifyStatus(status int, providerText string) error {
	reason := fmt.Sprintf("the provider answered %d %s", status, http.StatusText(status))
	if providerText != "" {
		reason += ": " + providerText
	}
	switch {
	case status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable || status == http.StatusRequestTimeout:
		return mailsetup.NotSentRetry(reason)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return mailsetup.NotSentRefused("the provider refused the API key (" + reason + ")")
	case status >= 300 && status < 500:
		return mailsetup.NotSentRefused(reason)
	default:
		return mailsetup.MaybeSent("May have been sent: check the provider's activity log before approving it again (" + reason + ")")
	}
}

// excerpt is the start of a reply, on one line, for a failure reason.
func excerpt(reply []byte) string {
	text := strings.Join(strings.Fields(string(reply)), " ")
	if len(text) > maxReasonLength {
		text = text[:maxReasonLength] + "…"
	}
	return text
}

// redact removes the credential from provider or transport text.
func redact(text string, secret mailsetup.Secret) string {
	return mailsetup.Redact(text, secret)
}
