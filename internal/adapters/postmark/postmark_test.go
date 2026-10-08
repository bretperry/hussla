// Tests for the Postmark adapter against an httptest server: the request it writes and what it reads back.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package postmark_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/adapters/postmark"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const token = "pm-synthetic-token" // synthetic

func message() mailsetup.Message {
	return mailsetup.Message{
		From: mailsetup.Address{Email: "jane@example.com", Name: "Jane"}, To: []string{"a@example.org", "b@example.org"},
		Subject: "Hello", Body: "Hi.\n", MessageID: "hussla.e1.v1@example.com",
	}
}

func newSender(t *testing.T, url string) *postmark.Sender {
	t.Helper()
	sender, err := postmark.New(mailsetup.Connection{BaseURL: url, Secret: mailsetup.NewSecret(token)}, mailhttp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return sender
}

func TestSendsTheDocumentedRequest(t *testing.T) {
	var path, gotToken string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path, gotToken = request.URL.Path, request.Header.Get("X-Postmark-Server-Token")
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = writer.Write([]byte(`{"ErrorCode":0,"Message":"OK","MessageID":"b7bc2f4a"}`))
	}))
	defer server.Close()
	receipt, err := newSender(t, server.URL).Send(context.Background(), message())
	if err != nil || receipt.ProviderMessageID != "b7bc2f4a" {
		t.Fatalf("receipt %+v, err %v", receipt, err)
	}
	if path != "/email" || gotToken != token || body["To"] != "a@example.org, b@example.org" || body["TextBody"] != "Hi.\n" || body["MessageStream"] != "outbound" {
		t.Errorf("path %q token %q body %v", path, gotToken, body)
	}
}

func TestPostmarkRefusalIsNotRetriedAndHidesTheToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = writer.Write([]byte(`{"ErrorCode":406,"Message":"Inactive recipient; token ` + token + `"}`))
	}))
	defer server.Close()
	_, err := newSender(t, server.URL).Send(context.Background(), message())
	var deliveryError *mailsetup.DeliveryError
	if !errors.As(err, &deliveryError) || deliveryError.Delivery != mailsetup.DeliveryNotSentRefused {
		t.Fatalf("err %v", err)
	}
	if strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "Inactive recipient") {
		t.Errorf("reason = %q", err.Error())
	}
}
