// Tests for the Mailgun adapter against an httptest server: the request it writes and what it reads back.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package mailgun_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/mailgun"
	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const apiKey = "key-synthetic" // synthetic

func TestSendsTheDocumentedRequest(t *testing.T) {
	var path, user, password string
	var basicOK bool
	fields := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.Path
		user, password, basicOK = request.BasicAuth()
		if err := request.ParseMultipartForm(1 << 20); err == nil {
			for name, values := range request.MultipartForm.Value {
				fields[name] = values[0]
			}
		}
		_, _ = writer.Write([]byte(`{"id":"<20261008.1@mg.example.com>","message":"Queued. Thank you."}`))
	}))
	defer server.Close()
	sender, err := mailgun.New(mailsetup.Connection{BaseURL: server.URL, Domain: "mg.example.com", Secret: mailsetup.NewSecret(apiKey)}, mailhttp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := sender.Send(context.Background(), mailsetup.Message{
		From: mailsetup.Address{Email: "jane@mg.example.com", Name: "Jane"}, To: []string{"a@example.org", "b@example.org"},
		Cc: []string{"c@example.org"}, Subject: "Hello", Body: "Hi.\n", MessageID: "hussla.e1.v1@mg.example.com",
	})
	if err != nil || receipt.ProviderMessageID != "20261008.1@mg.example.com" {
		t.Fatalf("receipt %+v, err %v", receipt, err)
	}
	if path != "/v3/mg.example.com/messages" || !basicOK || user != "api" || password != apiKey {
		t.Errorf("path %q auth %q/%q", path, user, password)
	}
	want := map[string]string{
		"from": `"Jane" <jane@mg.example.com>`, "to": "a@example.org,b@example.org", "cc": "c@example.org",
		"subject": "Hello", "text": "Hi.\n", "h:X-Hussla-Message-Id": "hussla.e1.v1@mg.example.com",
	}
	for name, value := range want {
		if fields[name] != value {
			t.Errorf("field %s = %q, want %q", name, fields[name], value)
		}
	}
}

func TestNeedsADomain(t *testing.T) {
	if _, err := mailgun.New(mailsetup.Connection{BaseURL: "https://api.mailgun.net", Secret: mailsetup.NewSecret(apiKey)}, mailhttp.Options{}); err == nil {
		t.Error("a sender without a domain was built")
	}
}
