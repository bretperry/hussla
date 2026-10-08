// An in-process fake SMTP server for the adapter's tests: STARTTLS or TLS, AUTH PLAIN/LOGIN, and scripted faults.
// In the app: nothing (tests only); no test ever reaches a real mail server.
// Used by: smtpmail_test.go.
// Uses: a throwaway self-signed certificate for 127.0.0.1, made per test.

package smtpmail_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeOptions script how the fake server behaves.
type fakeOptions struct {
	implicitTLS    bool   // TLS from the first byte (port 465 style)
	noSTARTTLS     bool   // don't offer STARTTLS
	authMechanisms string // what EHLO offers after TLS; default "PLAIN LOGIN"
	echoAuthOnFail bool   // reply 535 with the AUTH payload echoed back (a careless server)
	mailReply      string // reply to MAIL FROM; default "250 OK"
	refuseRcpt     string // a recipient answered with 550
	hangAfterDot   bool   // never answer the final "."
	finalReply     string // answer to the final "."; default "250 OK queued"
}

// receivedMessage is one message the fake took.
type receivedMessage struct {
	from       string
	recipients []string
	data       []byte // dot-unstuffed, as the server would deliver it
}

type fakeServer struct {
	t        *testing.T
	listener net.Listener
	tls      *tls.Config
	roots    *x509.CertPool
	options  fakeOptions
	username string
	password string

	mutex       sync.Mutex
	connections int
	authSeen    []string // the mechanism of each AUTH attempt
	messages    []receivedMessage
	release     chan struct{}
}

func startFakeServer(t *testing.T, username, password string, options fakeOptions) *fakeServer {
	t.Helper()
	certificate, roots := selfSignedCertificate(t)
	server := &fakeServer{
		t: t, tls: &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12},
		roots: roots, options: options, username: username, password: password, release: make(chan struct{}),
	}
	if server.options.authMechanisms == "" {
		server.options.authMechanisms = "PLAIN LOGIN"
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server.listener = listener
	go server.accept()
	t.Cleanup(func() {
		close(server.release)
		_ = listener.Close()
	})
	return server
}

func (server *fakeServer) port() int { return server.listener.Addr().(*net.TCPAddr).Port }

func (server *fakeServer) snapshot() (connections int, authSeen []string, messages []receivedMessage) {
	server.mutex.Lock()
	defer server.mutex.Unlock()
	return server.connections, append([]string(nil), server.authSeen...), append([]receivedMessage(nil), server.messages...)
}

func (server *fakeServer) accept() {
	for {
		conn, err := server.listener.Accept()
		if err != nil {
			return
		}
		server.mutex.Lock()
		server.connections++
		server.mutex.Unlock()
		go server.serve(conn)
	}
}

func (server *fakeServer) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	secure := false
	if server.options.implicitTLS {
		conn = tls.Server(conn, server.tls)
		secure = true
	}
	text := textproto.NewConn(conn)
	reply := func(line string) { _ = text.PrintfLine("%s", line) }
	reply("220 fake.test ESMTP")
	var current receivedMessage
	for {
		line, err := text.ReadLine()
		if err != nil {
			return
		}
		verb, argument, _ := strings.Cut(line, " ")
		switch strings.ToUpper(verb) {
		case "EHLO", "HELO":
			lines := []string{"250-fake.test"}
			if !secure && !server.options.noSTARTTLS {
				lines = append(lines, "250-STARTTLS")
			}
			if secure {
				lines = append(lines, "250-AUTH "+server.options.authMechanisms)
			}
			lines = append(lines, "250 8BITMIME")
			for _, each := range lines {
				reply(each)
			}
		case "STARTTLS":
			reply("220 go ahead")
			tlsConn := tls.Server(conn, server.tls)
			if err := tlsConn.Handshake(); err != nil {
				return
			}
			conn, secure = tlsConn, true
			text = textproto.NewConn(conn)
			reply = func(line string) { _ = text.PrintfLine("%s", line) }
		case "AUTH":
			if !server.authenticate(text, reply, argument) {
				continue
			}
		case "MAIL":
			if server.options.mailReply != "" {
				reply(server.options.mailReply)
				continue
			}
			current = receivedMessage{from: addressIn(argument)}
			reply("250 OK")
		case "RCPT":
			recipient := addressIn(argument)
			if recipient == server.options.refuseRcpt {
				reply("550 5.1.1 no such user")
				continue
			}
			current.recipients = append(current.recipients, recipient)
			reply("250 OK")
		case "DATA":
			reply("354 end with .")
			data, err := text.ReadDotBytes()
			if err != nil {
				return
			}
			current.data = data
			server.mutex.Lock()
			server.messages = append(server.messages, current)
			server.mutex.Unlock()
			if server.options.hangAfterDot {
				<-server.release
				return
			}
			if server.options.finalReply != "" {
				reply(server.options.finalReply)
				continue
			}
			reply("250 OK queued as FAKE123")
		case "QUIT":
			reply("221 bye")
			return
		default:
			reply("250 OK")
		}
	}
}

// authenticate handles AUTH PLAIN (initial response) and AUTH LOGIN; it reports success.
func (server *fakeServer) authenticate(text *textproto.Conn, reply func(string), argument string) bool {
	mechanism, initial, _ := strings.Cut(argument, " ")
	server.mutex.Lock()
	server.authSeen = append(server.authSeen, strings.ToUpper(mechanism))
	server.mutex.Unlock()
	var username, password, payload string
	switch strings.ToUpper(mechanism) {
	case "PLAIN":
		payload = initial
		decoded, _ := base64.StdEncoding.DecodeString(initial)
		parts := strings.Split(string(decoded), "\x00")
		if len(parts) == 3 {
			username, password = parts[1], parts[2]
		}
	case "LOGIN":
		reply("334 " + base64.StdEncoding.EncodeToString([]byte("Username:")))
		userLine, _ := text.ReadLine()
		reply("334 " + base64.StdEncoding.EncodeToString([]byte("Password:")))
		passLine, _ := text.ReadLine()
		payload = passLine
		decodedUser, _ := base64.StdEncoding.DecodeString(userLine)
		decodedPass, _ := base64.StdEncoding.DecodeString(passLine)
		username, password = string(decodedUser), string(decodedPass)
	}
	if username != server.username || password != server.password || server.options.echoAuthOnFail {
		if server.options.echoAuthOnFail {
			reply("535 5.7.8 authentication failed for " + payload + " (" + password + ")")
		} else {
			reply("535 5.7.8 authentication failed")
		}
		return false
	}
	reply("235 2.7.0 accepted")
	return true
}

func addressIn(argument string) string {
	start, end := strings.Index(argument, "<"), strings.Index(argument, ">")
	if start < 0 || end < start {
		return argument
	}
	return argument[start+1 : end]
}

// selfSignedCertificate makes a one-day certificate for 127.0.0.1 and a pool that trusts it.
func selfSignedCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fake.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}

// closedPort is a local port nothing listens on.
func closedPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}
