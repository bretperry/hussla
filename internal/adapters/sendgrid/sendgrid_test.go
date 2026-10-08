// Tests for the SendGrid adapter against an httptest server: the request it writes and what it reads back.
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package sendgrid_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/adapters/sendgrid"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const apiKey = "SG.synthetic" // synthetic

type requestBody struct {
	Personalizations []struct {
		To []struct{ Email string } `json:"to"`
		Cc []struct{ Email string } `json:"cc"`
	} `json:"personalizations"`
	From    struct{ Email, Name string }   `json:"from"`
	Subject string                         `json:"subject"`
	Content []struct{ Type, Value string } `json:"content"`
}

func TestSendsTheDocumentedRequestAndDropsACcThatRepeatsATo(t *testing.T) {
	var path, auth string
	var body requestBody
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path, auth = request.URL.Path, request.Header.Get("Authorization")
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &body)
		writer.Header().Set("X-Message-Id", "sg-id-1")
		writer.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	sender, err := sendgrid.New(mailsetup.Connection{BaseURL: server.URL, Secret: mailsetup.NewSecret(apiKey)}, mailhttp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := sender.Send(context.Background(), mailsetup.Message{
		From: mailsetup.Address{Email: "jane@example.com", Name: "Jane"}, To: []string{"a@example.org"},
		Cc: []string{"A@example.org", "c@example.org"}, Subject: "Hello", Body: "Hi.\n", MessageID: "hussla.e1.v1@example.com",
	})
	if err != nil || receipt.ProviderMessageID != "sg-id-1" {
		t.Fatalf("receipt %+v, err %v", receipt, err)
	}
	if path != "/v3/mail/send" || auth != "Bearer "+apiKey {
		t.Errorf("path %q auth %q", path, auth)
	}
	if len(body.Personalizations) != 1 || len(body.Personalizations[0].To) != 1 || len(body.Personalizations[0].Cc) != 1 ||
		body.Personalizations[0].Cc[0].Email != "c@example.org" {
		t.Errorf("personalizations = %+v", body.Personalizations)
	}
	if body.From.Email != "jane@example.com" || body.From.Name != "Jane" || body.Subject != "Hello" ||
		len(body.Content) != 1 || body.Content[0].Type != "text/plain" || body.Content[0].Value != "Hi.\n" {
		t.Errorf("body = %+v", body)
	}
}
