// Tests for the shared HTTP mail plumbing against httptest servers: what each failure means for "never send twice".
// In the app: nothing (tests only).
// Used by: pnpm go:test.

package mailhttp_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/mailhttp"
	"github.com/bretperry/hussla/internal/app/mailsetup"
)

const apiKey = "re_synthetic_key_123456" // synthetic

func deliveryOf(t *testing.T, err error) mailsetup.Delivery {
	t.Helper()
	var deliveryError *mailsetup.DeliveryError
	if !errors.As(err, &deliveryError) {
		t.Fatalf("error %v (%T) isn't a *mailsetup.DeliveryError", err, err)
	}
	return deliveryError.Delivery
}

func post(t *testing.T, url string, options mailhttp.Options) (mailhttp.Response, error) {
	t.Helper()
	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)
	return mailhttp.NewClient(options).Post(context.Background(), url, header, []byte(`{}`), mailsetup.NewSecret(apiKey))
}

func TestStatusesMapToDeliveries(t *testing.T) {
	cases := []struct {
		status int
		want   mailsetup.Delivery
	}{
		{http.StatusTooManyRequests, mailsetup.DeliveryNotSentRetry},
		{http.StatusServiceUnavailable, mailsetup.DeliveryNotSentRetry},
		{http.StatusRequestTimeout, mailsetup.DeliveryNotSentRetry},
		{http.StatusUnauthorized, mailsetup.DeliveryNotSentRefused},
		{http.StatusForbidden, mailsetup.DeliveryNotSentRefused},
		{http.StatusBadRequest, mailsetup.DeliveryNotSentRefused},
		{http.StatusUnprocessableEntity, mailsetup.DeliveryNotSentRefused},
		{http.StatusFound, mailsetup.DeliveryNotSentRefused},
		{http.StatusConflict, mailsetup.DeliveryNotSentRefused},
		{http.StatusInternalServerError, mailsetup.DeliveryMaybeSent},
		{http.StatusBadGateway, mailsetup.DeliveryMaybeSent},
		{http.StatusGatewayTimeout, mailsetup.DeliveryMaybeSent},
	}
	for _, testCase := range cases {
		t.Run(http.StatusText(testCase.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Location", "https://elsewhere.example/")
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(`{"message":"bad key ` + apiKey + `"}`))
			}))
			defer server.Close()
			_, err := post(t, server.URL, mailhttp.Options{})
			if got := deliveryOf(t, err); got != testCase.want {
				t.Errorf("delivery = %v, want %v (%v)", got, testCase.want, err)
			}
			if strings.Contains(err.Error(), apiKey) {
				t.Errorf("error leaks the key: %v", err)
			}
		})
	}
}

func TestSuccessReturnsTheReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte(`{"id":"abc"}`))
	}))
	defer server.Close()
	response, err := post(t, server.URL, mailhttp.Options{})
	if err != nil || response.Status != http.StatusAccepted || string(response.Body) != `{"id":"abc"}` {
		t.Fatalf("response %+v, err %v", response, err)
	}
}

func TestUnreachableIsRetryable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + listener.Addr().String()
	_ = listener.Close()
	_, err = post(t, url, mailhttp.Options{ConnectTimeout: time.Second})
	if got := deliveryOf(t, err); got != mailsetup.DeliveryNotSentRetry {
		t.Errorf("delivery = %v (%v)", got, err)
	}
}

func TestNoAnswerAfterTheRequestIsMaybeSent(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer server.Close()
	defer close(release)
	_, err := post(t, server.URL, mailhttp.Options{DeliveryTimeout: 300 * time.Millisecond})
	if got := deliveryOf(t, err); got != mailsetup.DeliveryMaybeSent {
		t.Errorf("delivery = %v (%v); a request the provider received must never be retried", got, err)
	}
}

func TestConnectionDroppedAfterTheRequestIsMaybeSent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		conn, _, err := writer.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer server.Close()
	_, err := post(t, server.URL, mailhttp.Options{})
	if got := deliveryOf(t, err); got != mailsetup.DeliveryMaybeSent {
		t.Errorf("delivery = %v (%v)", got, err)
	}
}

func TestCancelledBeforeSendingSendsNothing(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := mailhttp.NewClient(mailhttp.Options{}).Post(ctx, server.URL, http.Header{}, nil, mailsetup.NewSecret(apiKey))
	if got := deliveryOf(t, err); got != mailsetup.DeliveryNotSentRetry || requests.Load() != 0 {
		t.Errorf("delivery = %v, %d requests", got, requests.Load())
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { followed.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.RedirectHandler(target.URL, http.StatusTemporaryRedirect))
	defer server.Close()
	_, err := post(t, server.URL, mailhttp.Options{})
	if err == nil || followed.Load() != 0 {
		t.Errorf("redirect followed (%d) or accepted (%v): the key would go to another host", followed.Load(), err)
	}
}

func TestBaseURLMustBeHTTPSUnlessLoopback(t *testing.T) {
	for url, ok := range map[string]bool{
		"https://api.resend.com":    true,
		"http://127.0.0.1:8080":     true,
		"http://localhost:9":        true,
		"http://api.resend.com":     false,
		"http://192.168.1.10":       false,
		"ftp://api.resend.com":      false,
		"not a url":                 false,
		"https://":                  false,
		"http://127.0.0.1.evil.com": false,
	} {
		if err := mailhttp.CheckBaseURL(url); (err == nil) != ok {
			t.Errorf("CheckBaseURL(%q) = %v", url, err)
		}
	}
}
