package tjucli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type catalogRedirectTransport func(*http.Request) (*http.Response, error)

func (f catalogRedirectTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestCatalogRejectsRedirectOutsideProviderHosts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://not-course.invalid/?token=synthetic-secret", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	provider := testProvider(t, server)
	original := provider.client.Transport
	if original == nil {
		original = http.DefaultTransport
	}
	provider.client.Transport = catalogRedirectTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Hostname() == "not-course.invalid" {
			t.Error("transport reached a forbidden redirect host")
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"folder":{"value":[]}}`))}, nil
		}
		return original.RoundTrip(r)
	})
	_, _, err := provider.List(context.Background(), "/", "")
	if err == nil || err.Code != "upstream_error" {
		t.Fatalf("expected rejected upstream redirect, got %v", err)
	}
	if strings.Contains(err.Message, "synthetic-secret") || strings.Contains(err.Message, "not-course.invalid") {
		t.Fatal("redirect destination leaked in error")
	}
}
