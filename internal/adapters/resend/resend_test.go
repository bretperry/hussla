// Tests for the Resend adapter against an httptest server: the request it writes and what it reads back.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package resend_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/adapters/resend"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const apiKey = "re_synthetic_123" // synthetic

func message() mailsetup.Message {
	return mailsetup.Message{
		From: mailsetup.Address{Email: "jane@example.com", Name: "Jane Doe"}, To: []string{"r@example.org"},
		Cc: []string{"h@example.org"}, Subject: "Café follow-up", Body: "Hi.\n",
		MessageID: "hussla.e1.v2@example.com", IdempotencyKey: "hussla-e1-v2",
	}
}

func TestSendsTheDocumentedRequest(t *testing.T) {
	var got struct {
		method, path, auth, idempotency string
		body                            map[string]any
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		got.method, got.path = request.Method, request.URL.Path
		got.auth, got.idempotency = request.Header.Get("Authorization"), request.Header.Get("Idempotency-Key")
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &got.body)
		_, _ = writer.Write([]byte(`{"id":"49a3999c"}`))
	}))
	defer server.Close()
	sender, err := resend.New(mailsetup.Connection{BaseURL: server.URL, Secret: mailsetup.NewSecret(apiKey)}, mailhttp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := sender.Send(context.Background(), message())
	if err != nil || receipt.ProviderMessageID != "49a3999c" {
		t.Fatalf("receipt %+v, err %v", receipt, err)
	}
	if got.method != http.MethodPost || got.path != "/emails" || got.auth != "Bearer "+apiKey || got.idempotency != "hussla-e1-v2" {
		t.Errorf("request %s %s auth=%q idempotency=%q", got.method, got.path, got.auth, got.idempotency)
	}
	if got.body["from"] != `"Jane Doe" <jane@example.com>` || got.body["subject"] != "Café follow-up" || got.body["text"] != "Hi.\n" {
		t.Errorf("body = %v", got.body)
	}
	if to, _ := got.body["to"].([]any); len(to) != 1 || to[0] != "r@example.org" {
		t.Errorf("to = %v", got.body["to"])
	}
}

func TestRefusesInjectedHeadersWithoutCallingTheAPI(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	sender, err := resend.New(mailsetup.Connection{BaseURL: server.URL, Secret: mailsetup.NewSecret(apiKey)}, mailhttp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	bad := message()
	bad.Subject = "Hi\r\nBcc: victim@example.net"
	_, err = sender.Send(context.Background(), bad)
	var deliveryError *mailsetup.DeliveryError
	if !errors.As(err, &deliveryError) || deliveryError.Delivery != mailsetup.DeliveryNotSentRefused || called {
		t.Errorf("err %v, called %v", err, called)
	}
}
