package task

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/auth"
)

const maxRequestBodyBytes = 16 << 10 // 16 KiB

// Handler provides HTTP endpoints for task management.
type Handler struct {
	store   *Store
	gateway *auth.Gateway
}

// NewHandler creates a new task HTTP handler.
func NewHandler(store *Store, gateway *auth.Gateway) *Handler {
	return &Handler{
		store:   store,
		gateway: gateway,
	}
}

// Register mounts the task routes onto the mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /tasks", h.list)
	mux.HandleFunc("POST /tasks", h.create)
	mux.HandleFunc("GET /tasks/{id}", h.get)
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

func (h *Handler) requireAuth(w http.ResponseWriter, r *http.Request) (*auth.Session, bool) {
	if h.gateway == nil {
		fail(w, http.StatusServiceUnavailable, "auth_not_configured")
		return nil, false
	}
	return h.gateway.RequireSession(w, r)
}

type createTaskRequest struct {
	Prompt *string `json:"prompt"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireAuth(w, r)
	if !ok {
		return
	}

	contentType := r.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return
	}

	if !utf8.Valid(body) {
		fail(w, http.StatusBadRequest, "invalid_task")
		return
	}

	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()

	var req createTaskRequest
	if err := dec.Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid_task")
		return
	}

	// A second decode must reach EOF; More only checks array/object delimiters.
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		fail(w, http.StatusBadRequest, "invalid_task")
		return
	}

	if req.Prompt == nil {
		fail(w, http.StatusBadRequest, "invalid_task")
		return
	}

	trimmed := strings.TrimSpace(*req.Prompt)
	runeCount := utf8.RuneCountInString(trimmed)
	if runeCount < 1 || runeCount > MaxPromptRunes {
		fail(w, http.StatusBadRequest, "invalid_task")
		return
	}

	task, err := h.store.Create(session.Identity.ID, *req.Prompt)
	if err != nil {
		if errors.Is(err, ErrTaskLimitReached) {
			fail(w, http.StatusConflict, "task_limit_reached")
			return
		}
		if errors.Is(err, ErrInvalidTask) {
			fail(w, http.StatusBadRequest, "invalid_task")
			return
		}
		fail(w, http.StatusServiceUnavailable, "task_storage_unavailable")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"task": task})
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireAuth(w, r)
	if !ok {
		return
	}

	tasks, err := h.store.List(session.Identity.ID)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "task_storage_unavailable")
		return
	}

	if tasks == nil {
		tasks = []Task{}
	}

	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireAuth(w, r)
	if !ok {
		return
	}

	id := r.PathValue("id")
	if !isValidTaskID(id) {
		fail(w, http.StatusNotFound, "task_not_found")
		return
	}

	task, err := h.store.Get(session.Identity.ID, id)
	if err != nil {
		if errors.Is(err, ErrTaskNotFound) {
			fail(w, http.StatusNotFound, "task_not_found")
			return
		}
		fail(w, http.StatusServiceUnavailable, "task_storage_unavailable")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"task": task})
}
