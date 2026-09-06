// Package auth owns the browser-only Kratos boundary. It never issues identities,
// codes, tokens, or an alternative application session.
package auth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Gateway struct {
	upstream *url.URL
	origin   *url.URL
	client   *http.Client
	proxy    *httputil.ReverseProxy
}

func New(upstream, publicOrigin string) (*Gateway, error) {
	u, err := url.Parse(upstream)
	if err != nil || !validOrigin(u) {
		return nil, errors.New("KRATOS_PUBLIC_URL must be an HTTP(S) origin without credentials or path")
	}
	o, err := url.Parse(publicOrigin)
	if err != nil || !validOrigin(o) || (o.Scheme != "https" && o.Hostname() != "127.0.0.1" && o.Hostname() != "localhost") {
		return nil, errors.New("APP_PUBLIC_URL must be HTTPS (HTTP is allowed only on loopback)")
	}
	u.Path, o.Path = "", ""
	g := &Gateway{upstream: u, origin: o, client: &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
	g.proxy = &httputil.ReverseProxy{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 8 * time.Second,
			IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 5 * time.Second,
		},
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(u)
			p.Out.URL.Path = strings.TrimPrefix(p.In.URL.Path, "/kratos")
			p.Out.Host = o.Host
			// Never trust forwarding headers supplied by the browser.
			p.Out.Header.Del("Forwarded")
			p.Out.Header.Del("X-Forwarded-For")
			p.Out.Header.Set("X-Forwarded-Host", o.Host)
			p.Out.Header.Set("X-Forwarded-Proto", o.Scheme)
			p.Out.Header.Del("Authorization")
			p.Out.Header.Del("X-Session-Token")
			p.Out.Header.Set("Accept", "application/json")
		},
		ModifyResponse: func(r *http.Response) error {
			r.Header.Set("Cache-Control", "no-store")
			r.Header.Del("Access-Control-Allow-Origin")
			if location := r.Header.Get("Location"); location != "" {
				target, err := url.Parse(location)
				if err != nil || target.IsAbs() && (target.Scheme != o.Scheme || target.Host != o.Host) || strings.HasPrefix(location, "//") {
					return errors.New("unexpected upstream redirect")
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			fail(w, http.StatusServiceUnavailable, "auth_unavailable")
		},
	}
	return g, nil
}

func validOrigin(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" &&
		u.User == nil && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && u.Fragment == ""
}

var flowPath = regexp.MustCompile(`^/self-service/(login|registration|verification)(/browser|/flows)?$`)

func allowed(method, path string) bool {
	if method == http.MethodGet {
		return flowPath.MatchString(path) && (strings.HasSuffix(path, "/browser") || strings.HasSuffix(path, "/flows")) ||
			path == "/self-service/logout/browser" || path == "/self-service/logout" || path == "/self-service/errors"
	}
	return method == http.MethodPost && flowPath.MatchString(path) &&
		!strings.HasSuffix(path, "/browser") && !strings.HasSuffix(path, "/flows")
}

func (g *Gateway) Register(mux *http.ServeMux) {
	mux.HandleFunc("/kratos/", g.flow)
	mux.HandleFunc("GET /auth/session", g.session)
}

func (g *Gateway) sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != strings.TrimSuffix(g.origin.String(), "/") {
		return false
	}
	// JSON mutations must come from our web origin. Kratos validates CSRF too.
	return r.Method == http.MethodGet || origin != ""
}

func (g *Gateway) flow(w http.ResponseWriter, r *http.Request) {
	if !g.sameOrigin(r) {
		fail(w, http.StatusForbidden, "origin_rejected")
		return
	}
	if r.URL.RawPath != "" || !allowed(r.Method, strings.TrimPrefix(r.URL.Path, "/kratos")) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	// Do not allow caller-controlled return URLs or native token/session routes.
	for key := range r.URL.Query() {
		if key != "flow" && key != "id" && key != "refresh" && key != "token" {
			fail(w, http.StatusBadRequest, "invalid_query")
			return
		}
	}
	if r.Method == http.MethodPost {
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			fail(w, http.StatusUnsupportedMediaType, "json_required")
			return
		}
		// Buffer a bounded payload before forwarding, so oversized requests never
		// partially reach the identity service.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
		if err != nil {
			fail(w, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal(body, &payload) != nil {
			fail(w, http.StatusBadRequest, "invalid_json")
			return
		}
		for key := range payload {
			switch key {
			case "method", "csrf_token", "identifier", "email", "traits", "code", "resend":
			default:
				fail(w, http.StatusBadRequest, "invalid_field")
				return
			}
		}
		if string(payload["method"]) != `"code"` {
			fail(w, http.StatusBadRequest, "email_code_required")
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		r.ContentLength = int64(len(body))
	}
	g.proxy.ServeHTTP(w, r)
}

type Session struct {
	Active    bool      `json:"active"`
	ExpiresAt time.Time `json:"expires_at"`
	Identity  struct {
		ID     string `json:"id"`
		Traits struct {
			Email string `json:"email"`
		} `json:"traits"`
		Addresses []struct {
			Value    string `json:"value"`
			Verified bool   `json:"verified"`
			Via      string `json:"via"`
		} `json:"verifiable_addresses"`
	} `json:"identity"`
}

// RequireSession is the baseline for all future authenticated API handlers.
// Ownership checks must use Identity.ID, never an ID supplied by the client.
func (g *Gateway) RequireSession(w http.ResponseWriter, r *http.Request) (*Session, bool) {
	if !g.sameOrigin(r) {
		fail(w, http.StatusForbidden, "origin_rejected")
		return nil, false
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, g.upstream.String()+"/sessions/whoami", nil)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "auth_unavailable")
		return nil, false
	}
	req.Header.Set("Cookie", r.Header.Get("Cookie"))
	req.Header.Set("Accept", "application/json")
	res, err := g.client.Do(req)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "auth_unavailable")
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		fail(w, http.StatusUnauthorized, "session_required")
		return nil, false
	}
	var session Session
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&session) != nil {
		fail(w, http.StatusServiceUnavailable, "auth_unavailable")
		return nil, false
	}
	if !session.Active || session.Identity.ID == "" || !session.ExpiresAt.After(time.Now()) {
		fail(w, http.StatusUnauthorized, "session_required")
		return nil, false
	}
	for _, cookie := range res.Header.Values("Set-Cookie") {
		w.Header().Add("Set-Cookie", cookie)
	}
	return &session, true
}

func (g *Gateway) session(w http.ResponseWriter, r *http.Request) {
	session, ok := g.RequireSession(w, r)
	if !ok {
		return
	}
	verified := false
	for _, address := range session.Identity.Addresses {
		verified = verified || address.Verified && address.Via == "email" && address.Value == session.Identity.Traits.Email
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": session.Identity.ID, "email": session.Identity.Traits.Email,
		"email_verified": verified, "expires_at": session.ExpiresAt,
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"id": code}})
}
