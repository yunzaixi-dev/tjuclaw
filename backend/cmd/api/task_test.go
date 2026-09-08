package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/auth"
	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/task"
)

func setupTaskAPI(t *testing.T, activeSession bool, identityID string) (http.Handler, *task.Store) {
	t.Helper()
	dir := t.TempDir()
	store, err := task.NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	kratos := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
				"traits": {"email": "test@example.com"}
			}
		}`, time.Now().Add(time.Hour).Format(time.RFC3339), identityID)
		_, _ = w.Write([]byte(resp))
	}))
	t.Cleanup(kratos.Close)

	gateway, err := auth.New(kratos.URL, "https://tjuclaw.agentwego.com")
	if err != nil {
		t.Fatal(err)
	}

	return handlerWithStore(store, gateway), store
}

func TestTaskAPIRoutes(t *testing.T) {
	h, _ := setupTaskAPI(t, true, "api-user-1")

	// 1. GET /tasks empty
	req := httptest.NewRequest("GET", "/tasks", nil)
	req.Header.Set("Cookie", "valid_session=true")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tasks status=%d, want 200", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("missing required security headers: %v", w.Header())
	}

	// 2. POST /tasks
	req = httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"prompt":"Integration test prompt"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://tjuclaw.agentwego.com")
	req.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /tasks status=%d, want 201: %s", w.Code, w.Body.String())
	}

	var createResp struct {
		Task task.Task `json:"task"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	taskID := createResp.Task.ID
	if taskID == "" {
		t.Fatal("empty task ID")
	}

	// 3. GET /tasks/{id}
	req = httptest.NewRequest("GET", "/tasks/"+taskID, nil)
	req.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tasks/{id} status=%d, want 200: %s", w.Code, w.Body.String())
	}

	// 4. GET /tasks now has 1 task
	req = httptest.NewRequest("GET", "/tasks", nil)
	req.Header.Set("Cookie", "valid_session=true")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tasks status=%d, want 200", w.Code)
	}
	var listResp struct {
		Tasks []task.Task `json:"tasks"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("failed to decode list: %v", err)
	}
	if len(listResp.Tasks) != 1 || listResp.Tasks[0].ID != taskID {
		t.Fatalf("unexpected list content: %#v", listResp)
	}
}

func TestTaskAPIUnconfiguredAuthReturns503(t *testing.T) {
	// Handler without gateway
	h := handler()

	for _, path := range []string{"/tasks", "/tasks/0123456789abcdef0123456789abcdef"} {
		req := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("GET %s status = %d, want 503", path, w.Code)
		}
		if !strings.Contains(w.Body.String(), "auth_not_configured") {
			t.Errorf("GET %s body = %s, want auth_not_configured", path, w.Body.String())
		}
	}
}
