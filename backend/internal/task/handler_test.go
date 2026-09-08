package task

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/auth"
)

type testHarness struct {
	store   *Store
	gateway *auth.Gateway
	mux     *http.ServeMux
}

func setupTestHarness(t *testing.T, activeSession bool, identityID string) *testHarness {
	t.Helper()
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	kratosUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/whoami" {
			http.NotFound(w, r)
			return
		}
		if !activeSession {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"id":"session_required"}}`))
			return
		}
		cookie := r.Header.Get("Cookie")
		if !strings.Contains(cookie, "valid_session=true") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"id":"session_required"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		resp := fmt.Sprintf(`{
			"active": true,
			"expires_at": %q,
			"identity": {
				"id": %q,
				"traits": {"email": "user@example.com"}
			}
		}`, time.Now().Add(time.Hour).Format(time.RFC3339), identityID)
		_, _ = w.Write([]byte(resp))
	}))
	t.Cleanup(kratosUpstream.Close)

	gateway, err := auth.New(kratosUpstream.URL, "https://tjuclaw.agentwego.com")
	if err != nil {
		t.Fatal(err)
	}

	handler := NewHandler(store, gateway)
	mux := http.NewServeMux()
	handler.Register(mux)

	return &testHarness{
		store:   store,
		gateway: gateway,
		mux:     mux,
	}
}

func TestHandlerAuthEnforcement(t *testing.T) {
	h := setupTestHarness(t, false, "")

	// Missing / invalid session returns 401
	for _, req := range []*http.Request{
		httptest.NewRequest("GET", "/tasks", nil),
		httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"prompt":"hello"}`)),
		httptest.NewRequest("GET", "/tasks/0123456789abcdef0123456789abcdef", nil),
	} {
		if req.Method == "POST" {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "https://tjuclaw.agentwego.com")
		}
		w := httptest.NewRecorder()
		h.mux.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: status=%d, want 401: %s", req.Method, req.URL.Path, w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Error("expected Cache-Control: no-store")
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Error("expected X-Content-Type-Options: nosniff")
		}
	}
}

func TestHandlerNoAuthGateway(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewStore(dir)
	defer store.Close()

	handler := NewHandler(store, nil)
	mux := http.NewServeMux()
	handler.Register(mux)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/tasks", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"auth_not_configured"`) {
		t.Fatalf("expected auth_not_configured error, got %s", w.Body.String())
	}
}

func TestHandlerCreateValidation(t *testing.T) {
	h := setupTestHarness(t, true, "user-test")

	tests := []struct {
		name        string
		contentType string
		body        string
		wantStatus  int
		wantCode    string
	}{
		{
			name:        "unsupported media type",
			contentType: "text/plain",
			body:        `{"prompt":"hello"}`,
			wantStatus:  http.StatusUnsupportedMediaType,
			wantCode:    "unsupported_media_type",
		},
		{
			name:        "application/json with charset ok",
			contentType: "application/json; charset=utf-8",
			body:        `{"prompt":"hello"}`,
			wantStatus:  http.StatusCreated,
		},
		{
			name:        "request too large",
			contentType: "application/json",
			body:        fmt.Sprintf(`{"prompt":%q}`, strings.Repeat("a", 17000)),
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantCode:    "request_too_large",
		},
		{
			name:        "empty prompt",
			contentType: "application/json",
			body:        `{"prompt":""}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "whitespace prompt",
			contentType: "application/json",
			body:        `{"prompt":"   \n\t  "}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "prompt too long runes",
			contentType: "application/json",
			body:        fmt.Sprintf(`{"prompt":%q}`, strings.Repeat("字", 4001)),
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "unknown fields",
			contentType: "application/json",
			body:        `{"prompt":"hello","extra":"not allowed"}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "client supplied owner or id or status",
			contentType: "application/json",
			body:        `{"prompt":"hello","id":"123","status":"done"}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "trailing json values",
			contentType: "application/json",
			body:        `{"prompt":"hello"}{"prompt":"again"}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "trailing closing brace",
			contentType: "application/json",
			body:        `{"prompt":"hello"}}`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "trailing closing bracket",
			contentType: "application/json",
			body:        `{"prompt":"hello"}]`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
		{
			name:        "malformed json",
			contentType: "application/json",
			body:        `{"prompt":`,
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_task",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/tasks", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.contentType)
			r.Header.Set("Origin", "https://tjuclaw.agentwego.com")
			r.Header.Set("Cookie", "valid_session=true")
			w := httptest.NewRecorder()
			h.mux.ServeHTTP(w, r)
			if w.Code != tc.wantStatus {
				t.Fatalf("status=%d, want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantCode != "" && !strings.Contains(w.Body.String(), tc.wantCode) {
				t.Fatalf("expected error code %s in body: %s", tc.wantCode, w.Body.String())
			}
		})
	}
}

func TestHandlerCRUDAndIsolation(t *testing.T) {
	h := setupTestHarness(t, true, "user-owner-a")

	// 1. Initially empty tasks array
	r := httptest.NewRequest("GET", "/tasks", nil)
	r.Header.Set("Cookie", "valid_session=true")
	w := httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tasks status=%d, want 200", w.Code)
	}
	if w.Body.String() != `{"tasks":[]}`+"\n" && w.Body.String() != `{"tasks":[]}` {
		t.Fatalf("expected empty tasks array, got %s", w.Body.String())
	}

	// 2. Create task
	createBody := `{"prompt":"Task 1 line 1\nTask 1 line 2"}`
	r = httptest.NewRequest("POST", "/tasks", strings.NewReader(createBody))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://tjuclaw.agentwego.com")
	r.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /tasks status=%d, want 201: %s", w.Code, w.Body.String())
	}

	var createResp struct {
		Task Task `json:"task"`
	}
	if err := json.NewDecoder(w.Body).Decode(&createResp); err != nil {
		t.Fatalf("failed to decode create response: %v", err)
	}
	task1 := createResp.Task
	if task1.ID == "" || len(task1.ID) != 32 {
		t.Fatalf("invalid task ID: %s", task1.ID)
	}
	if task1.Title != "Task 1 line 1" {
		t.Fatalf("unexpected title: %s", task1.Title)
	}
	if task1.Status != "draft" {
		t.Fatalf("unexpected status: %s", task1.Status)
	}

	// 3. GET /tasks/{id}
	r = httptest.NewRequest("GET", "/tasks/"+task1.ID, nil)
	r.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tasks/{id} status=%d, want 200", w.Code)
	}
	var getResp struct {
		Task Task `json:"task"`
	}
	if err := json.NewDecoder(w.Body).Decode(&getResp); err != nil {
		t.Fatalf("failed to decode get response: %v", err)
	}
	if getResp.Task.ID != task1.ID || getResp.Task.Prompt != task1.Prompt {
		t.Fatalf("mismatch in get: %#v vs %#v", getResp.Task, task1)
	}

	// 4. GET /tasks/{nonexistent_id} returns 404
	r = httptest.NewRequest("GET", "/tasks/00000000000000000000000000000000", nil)
	r.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET nonexistent status=%d, want 404", w.Code)
	}
	if !strings.Contains(w.Body.String(), "task_not_found") {
		t.Fatalf("expected task_not_found, got %s", w.Body.String())
	}

	// 5. Cross-owner check: switch identity to user-owner-b
	h2 := setupTestHarness(t, true, "user-owner-b")
	// point h2 handler to the same store
	h2.mux = http.NewServeMux()
	NewHandler(h.store, h2.gateway).Register(h2.mux)

	// user-owner-b cannot get task1 (returns 404)
	r = httptest.NewRequest("GET", "/tasks/"+task1.ID, nil)
	r.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h2.mux.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-owner GET status=%d, want 404: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "task_not_found") {
		t.Fatalf("expected task_not_found for cross-owner, got %s", w.Body.String())
	}

	// user-owner-b list is empty
	r = httptest.NewRequest("GET", "/tasks", nil)
	r.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h2.mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("user-owner-b GET /tasks status=%d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), `{"tasks":[]}`) {
		t.Fatalf("expected empty tasks for user-owner-b, got %s", w.Body.String())
	}
}
