package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	g, err := New(server.URL, "https://tjuclaw.agentwego.com")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	g.Register(mux)
	return mux
}

func TestConfiguration(t *testing.T) {
	for _, value := range []string{"", "https://user:pass@internal", "file:///tmp/auth", "https://internal/admin", "https://internal?key=secret"} {
		if _, err := New(value, "https://tjuclaw.agentwego.com"); err == nil {
			t.Fatalf("accepted invalid upstream %q", value)
		}
	}
	if _, err := New("http://kratos:4433", "http://tjuclaw.agentwego.com"); err == nil {
		t.Fatal("accepted non-TLS public origin")
	}
}

func TestBoundary(t *testing.T) {
	calls := 0
	h := setup(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/self-service/login" {
			t.Errorf("unexpected forwarded path %s", r.URL.Path)
		}
		if r.Header.Get("X-Forwarded-Host") != "tjuclaw.agentwego.com" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("untrusted forwarding headers")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Session-Token") != "" || r.Header.Get("Forwarded") != "" {
			t.Error("browser credentials leaked into native authentication")
		}
		if r.Header.Get("Cookie") != "csrf=test" {
			t.Error("CSRF cookie not preserved")
		}
		w.Header().Add("Set-Cookie", "session=test; HttpOnly; Secure; SameSite=Lax; Path=/")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	for _, tc := range []struct {
		name, method, path, origin, body string
		status                           int
	}{
		{"admin", "GET", "/kratos/admin/identities", "", "", 404},
		{"identities", "GET", "/kratos/identities", "", "", 404},
		{"native flow", "GET", "/kratos/self-service/login/api", "", "", 404},
		{"raw session", "GET", "/kratos/sessions/whoami", "", "", 404},
		{"unbounded return", "GET", "/kratos/self-service/login/browser?return_to=https://evil.test", "", "", 400},
		{"wrong origin", "POST", "/kratos/self-service/login", "https://evil.test", `{"method":"code"}`, 403},
		{"missing origin", "POST", "/kratos/self-service/login", "", `{"method":"code"}`, 403},
		{"password", "POST", "/kratos/self-service/login", "https://tjuclaw.agentwego.com", `{"method":"password"}`, 400},
		{"token request", "POST", "/kratos/self-service/login", "https://tjuclaw.agentwego.com", `{"method":"code","return_session_token_exchange_code":true}`, 400},
		{"oversized", "POST", "/kratos/self-service/login", "https://tjuclaw.agentwego.com", strings.Repeat("x", 17000), 413},
		{"valid", "POST", "/kratos/self-service/login", "https://tjuclaw.agentwego.com", `{"method":"code","csrf_token":"test"}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", "csrf=test")
			r.Header.Set("Authorization", "Bearer untrusted")
			r.Header.Set("X-Session-Token", "untrusted")
			r.Header.Set("Forwarded", "host=evil.test")
			r.Header.Set("X-Forwarded-Host", "evil.test")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Error("authentication must never be cached")
			}
			if tc.status == 200 && !strings.Contains(w.Header().Get("Set-Cookie"), "HttpOnly") {
				t.Error("session cookie lost")
			}
		})
	}
	if calls != 1 {
		t.Fatalf("rejected requests reached upstream: calls=%d", calls)
	}
}

func TestSessionRequiresLiveKratosAndMinimizesData(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{"guest", 401, `{}`, 401},
		{"offline", 503, `{}`, 503},
		{"invalid", 200, `not-json`, 503},
		{"inactive", 200, `{"active":false}`, 401},
		{"expired", 200, `{"active":true,"expires_at":"2020-01-01T00:00:00Z","identity":{"id":"id"}}`, 401},
		{"valid", 200, fmt.Sprintf(`{"active":true,"expires_at":%q,"session_token":"private","identity":{"id":"identity-1","traits":{"email":"test@example.com","secret":"private"},"verifiable_addresses":[{"value":"test@example.com","verified":true,"via":"email"}]}}`, time.Now().Add(time.Hour).Format(time.RFC3339)), 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := setup(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/sessions/whoami" || r.Header.Get("Cookie") != "session=test" || r.Header.Get("Authorization") != "" {
					t.Error("invalid session validation request")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			r := httptest.NewRequest("GET", "/auth/session", nil)
			r.Header.Set("Cookie", "session=test")
			r.Header.Set("Authorization", "Bearer fake")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d", w.Code, tc.want)
			}
			if strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "session_token") {
				t.Error("unnecessary private identity data exposed")
			}
			if tc.want == 200 && !strings.Contains(w.Body.String(), `"email_verified":true`) {
				t.Error("missing verified address")
			}
		})
	}
}

func TestCrossSiteReadsAndUpstreamRedirectsAreRejected(t *testing.T) {
	h := setup(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.test/", 302)
	})
	r := httptest.NewRequest("GET", "/kratos/self-service/login/browser", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 503 || w.Header().Get("Location") != "" {
		t.Fatal("external upstream redirect was exposed")
	}
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-site flow initialization accepted")
	}
}
