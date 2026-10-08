// The SMTP adapter: sends one email through an SMTP server over STARTTLS or TLS, with AUTH PLAIN or LOGIN.
// In the app: every SMTP provider in the catalog (iCloud, Gmail, Outlook, Yahoo, Fastmail, Zoho) and "Other SMTP".
// Used by: internal/adapters/mailfactory, which builds one per send from the owner's settings.
// Uses: net/smtp (the client), crypto/tls, mime and mime/quotedprintable (UTF-8 subject and body).
//
// Never send twice: everything up to the server's 354 reply to DATA is "not sent" (retryable,
// or refused when the server said 5xx); once the message is being handed over, a cut-off or a
// timeout is "may have been sent" and is never retried. The context can stop a send only before
// DATA; after that the send runs to its answer or config.MailDeliveryTimeout, so a shutdown in
// the middle doesn't turn a delivered email into an unknown one.
//
// No plaintext: a server that doesn't offer STARTTLS is refused, and net/smtp's PLAIN (and the
// LOGIN here) refuse to send a password over an unencrypted connection. Every header value is
// checked for CR, LF and NUL again here before a byte is written (security model).

package smtpmail

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// Options tune a Sender; the zero value is production (system roots, the config timeouts).
type Options struct {
	// RootCAs replaces the system's trusted roots (tests trust their fake server's certificate).
	RootCAs *x509.CertPool
	// ConnectTimeout bounds each step before DATA; 0 means config.MailConnectTimeout.
	ConnectTimeout time.Duration
	// DeliveryTimeout bounds handing over the message and its answer; 0 means config.MailDeliveryTimeout.
	DeliveryTimeout time.Duration
	// Now stamps the Date header; nil means time.Now.
	Now func() time.Time
}

// Sender is a mailsetup.MailSender for one SMTP server and account.
type Sender struct {
	connection mailsetup.Connection
	options    Options
}

var _ mailsetup.MailSender = (*Sender)(nil)

// New checks the connection settings and builds a sender; nothing is dialed until Send.
func New(connection mailsetup.Connection, options Options) (*Sender, error) {
	if connection.Host == "" || connection.Port <= 0 || connection.Port > 65535 {
		return nil, mailsetup.NotSentRefused("the SMTP server and port aren't set")
	}
	if err := domain.ValidateHeaderText("username", connection.Username); err != nil || connection.Username == "" {
		return nil, mailsetup.NotSentRefused("the SMTP username is missing or has a line break in it")
	}
	if options.ConnectTimeout <= 0 {
		options.ConnectTimeout = config.MailConnectTimeout
	}
	if options.DeliveryTimeout <= 0 {
		options.DeliveryTimeout = config.MailDeliveryTimeout
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Sender{connection: connection, options: options}, nil
}

// Send delivers one message. Errors are *mailsetup.DeliveryError, with the password removed from any server text.
func (sender *Sender) Send(ctx context.Context, message mailsetup.Message) (mailsetup.Receipt, error) {
	data, err := buildMessage(message, sender.options.Now())
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	receipt, err := sender.send(ctx, message, data)
	if err != nil {
		var deliveryError *mailsetup.DeliveryError
		if errors.As(err, &deliveryError) {
			return mailsetup.Receipt{}, &mailsetup.DeliveryError{Delivery: deliveryError.Delivery, Reason: sender.redact(deliveryError.Reason)}
		}
		return mailsetup.Receipt{}, mailsetup.MaybeSent(sender.redact(err.Error()))
	}
	return receipt, nil
}

func (sender *Sender) send(ctx context.Context, message mailsetup.Message, data []byte) (mailsetup.Receipt, error) {
	conn, err := sender.dial(ctx)
	if err != nil {
		return mailsetup.Receipt{}, err
	}
	defer func() { _ = conn.Close() }()

	// Until DATA, a cancelled context unblocks the connection (a past deadline fails the pending read).
	stopWatching := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	_ = conn.SetDeadline(time.Now().Add(sender.options.ConnectTimeout))

	client, err := smtp.NewClient(conn, sender.connection.Host)
	if err != nil {
		return mailsetup.Receipt{}, beforeData("greeting", err)
	}
	if err := sender.secureAndAuthenticate(client); err != nil {
		return mailsetup.Receipt{}, err
	}
	if err := client.Mail(message.From.Email); err != nil {
		return mailsetup.Receipt{}, beforeData("sender "+message.From.Email, err)
	}
	for _, recipient := range append(append([]string(nil), message.To...), message.Cc...) {
		if err := client.Rcpt(recipient); err != nil {
			return mailsetup.Receipt{}, beforeData("recipient "+recipient, err)
		}
	}
	if !stopWatching() {
		return mailsetup.Receipt{}, mailsetup.NotSentRetry("stopped before sending")
	}
	_ = conn.SetDeadline(time.Now().Add(sender.options.DeliveryTimeout))
	writer, err := client.Data()
	if err != nil {
		return mailsetup.Receipt{}, beforeData("DATA", err)
	}
	// From here the server may take the message: no outcome but a clear answer is "not sent".
	if _, err := writer.Write(data); err != nil {
		return mailsetup.Receipt{}, afterData(err)
	}
	if err := writer.Close(); err != nil {
		return mailsetup.Receipt{}, afterData(err)
	}
	_ = client.Quit() // the server has taken it; a failed goodbye changes nothing
	return mailsetup.Receipt{ProviderMessageID: message.MessageID}, nil
}

// dial connects, with TLS from the first byte when the security is TLS.
func (sender *Sender) dial(ctx context.Context) (net.Conn, error) {
	address := net.JoinHostPort(sender.connection.Host, strconv.Itoa(sender.connection.Port))
	dialer := &net.Dialer{Timeout: sender.options.ConnectTimeout}
	switch sender.connection.Security {
	case config.MailSecurityTLS:
		tlsDialer := &tls.Dialer{NetDialer: dialer, Config: sender.tlsConfig()}
		conn, err := tlsDialer.DialContext(ctx, "tcp", address)
		if err != nil {
			return nil, connectError(err)
		}
		return conn, nil
	case config.MailSecuritySTARTTLS:
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err != nil {
			return nil, connectError(err)
		}
		return conn, nil
	}
	return nil, mailsetup.NotSentRefused("unknown connection security")
}

// secureAndAuthenticate upgrades to TLS when STARTTLS is the security, then logs in.
func (sender *Sender) secureAndAuthenticate(client *smtp.Client) error {
	if sender.connection.Security == config.MailSecuritySTARTTLS {
		if offered, _ := client.Extension("STARTTLS"); !offered {
			return mailsetup.NotSentRefused("the server doesn't offer STARTTLS, so the email would cross the network unencrypted: check the port and security")
		}
		if err := client.StartTLS(sender.tlsConfig()); err != nil {
			return connectError(err)
		}
	}
	offered, mechanisms := client.Extension("AUTH")
	if !offered {
		return mailsetup.NotSentRefused("the server doesn't accept a login on this port")
	}
	var auth smtp.Auth
	switch {
	case hasMechanism(mechanisms, "PLAIN"):
		auth = smtp.PlainAuth("", sender.connection.Username, sender.connection.Secret.Reveal(), sender.connection.Host)
	case hasMechanism(mechanisms, "LOGIN"):
		auth = &loginAuth{username: sender.connection.Username, password: sender.connection.Secret.Reveal()}
	default:
		return mailsetup.NotSentRefused("the server offers no password login (" + mechanisms + "); Hussla supports PLAIN and LOGIN")
	}
	if err := client.Auth(auth); err != nil {
		var protocolError *textproto.Error
		if errors.As(err, &protocolError) && protocolError.Code >= 500 {
			return mailsetup.NotSentRefused(fmt.Sprintf("the server refused the username or password (%d %s)", protocolError.Code, protocolError.Msg))
		}
		return beforeData("login", err)
	}
	return nil
}

func (sender *Sender) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: sender.connection.Host, RootCAs: sender.options.RootCAs, MinVersion: tls.VersionTLS12}
}

// redact removes the password from server text: AUTH PLAIN's base64 of "\0user\0password" first,
// then the forms mailsetup.Redact knows (raw, and base64 as AUTH LOGIN sends it).
func (sender *Sender) redact(text string) string {
	secret := sender.connection.Secret
	if secret.IsEmpty() {
		return text
	}
	plain := base64.StdEncoding.EncodeToString([]byte("\x00" + sender.connection.Username + "\x00" + secret.Reveal()))
	return mailsetup.Redact(strings.ReplaceAll(text, plain, "[redacted]"), secret)
}

func hasMechanism(mechanisms, name string) bool {
	for _, mechanism := range strings.Fields(strings.ToUpper(mechanisms)) {
		if mechanism == name {
			return true
		}
	}
	return false
}

// beforeData classifies a failure before the message was handed over: nothing was sent. A 5xx
// reply won't change on retry; a 4xx reply, a timeout or a dropped connection might.
func beforeData(stage string, err error) error {
	var protocolError *textproto.Error
	if errors.As(err, &protocolError) {
		reason := fmt.Sprintf("%s: the server said %d %s", stage, protocolError.Code, protocolError.Msg)
		if protocolError.Code >= 500 {
			return mailsetup.NotSentRefused(reason)
		}
		return mailsetup.NotSentRetry(reason)
	}
	return mailsetup.NotSentRetry(stage + ": " + err.Error())
}

// afterData classifies a failure while handing over the message or waiting for its answer. A
// 5xx answer is a refusal (failed, not retried); anything else may have been delivered.
func afterData(err error) error {
	var protocolError *textproto.Error
	if errors.As(err, &protocolError) && protocolError.Code >= 500 {
		return mailsetup.NotSentRefused(fmt.Sprintf("the server refused the message: %d %s", protocolError.Code, protocolError.Msg))
	}
	return mailsetup.MaybeSent(domain.UncertainSendError + " (" + err.Error() + ")")
}

// connectError classifies a failure to connect or secure the connection: nothing was sent. A
// certificate that doesn't verify is refused (retrying won't fix it, and it may be an impostor).
func connectError(err error) error {
	var verificationError *tls.CertificateVerificationError
	var hostnameError x509.HostnameError
	var authorityError x509.UnknownAuthorityError
	if errors.As(err, &verificationError) || errors.As(err, &hostnameError) || errors.As(err, &authorityError) {
		return mailsetup.NotSentRefused("the server's certificate didn't verify: " + err.Error())
	}
	return mailsetup.NotSentRetry("couldn't connect: " + err.Error())
}

// loginAuth is AUTH LOGIN (Outlook and some older servers offer only it); net/smtp has PLAIN only.
type loginAuth struct {
	username string
	password string
}

func (auth *loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS {
		return "", nil, errors.New("refusing to send a password over an unencrypted connection")
	}
	return "LOGIN", nil, nil
}

func (auth *loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	prompt := strings.ToLower(string(fromServer))
	switch {
	case strings.Contains(prompt, "username"):
		return []byte(auth.username), nil
	case strings.Contains(prompt, "password"):
		return []byte(auth.password), nil
	}
	return nil, fmt.Errorf("unexpected login prompt %q", fromServer)
}

// buildMessage writes the headers and the quoted-printable body, refusing a CR, LF or NUL in any header value.
func buildMessage(message mailsetup.Message, now time.Time) ([]byte, error) {
	if err := mailsetup.ValidateMessage(message); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	from := (&mail.Address{Name: message.From.Name, Address: message.From.Email}).String()
	writeHeader(&buffer, "From", from)
	writeHeader(&buffer, "To", strings.Join(message.To, ", "))
	if len(message.Cc) > 0 {
		writeHeader(&buffer, "Cc", strings.Join(message.Cc, ", "))
	}
	writeHeader(&buffer, "Subject", encodeSubject(message.Subject))
	writeHeader(&buffer, "Date", now.Format(time.RFC1123Z))
	writeHeader(&buffer, "Message-ID", "<"+message.MessageID+">")
	writeHeader(&buffer, "MIME-Version", "1.0")
	writeHeader(&buffer, "Content-Type", "text/plain; charset=utf-8")
	writeHeader(&buffer, "Content-Transfer-Encoding", "quoted-printable")
	buffer.WriteString("\r\n")
	body := quotedprintable.NewWriter(&buffer)
	if _, err := body.Write([]byte(message.Body)); err != nil {
		return nil, mailsetup.NotSentRefused("encode the body: " + err.Error())
	}
	if err := body.Close(); err != nil {
		return nil, mailsetup.NotSentRefused("encode the body: " + err.Error())
	}
	return buffer.Bytes(), nil
}

func writeHeader(buffer *bytes.Buffer, name, value string) {
	buffer.WriteString(name + ": " + value + "\r\n")
}

// encodeSubject RFC 2047-encodes a non-ASCII subject and folds the encoded words onto
// continuation lines, so a long UTF-8 subject stays under SMTP's line limit.
func encodeSubject(subject string) string {
	encoded := mime.QEncoding.Encode("utf-8", subject)
	if encoded == subject {
		return subject
	}
	return strings.ReplaceAll(encoded, "?= =?", "?=\r\n =?")
}
