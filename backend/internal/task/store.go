package task

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	MaxTasksPerOwner      = 1000
	MaxPromptRunes        = 4000
	MaxTitleRunes         = 80
	maxPersistedTaskBytes = 64 << 10
)

var (
	ErrTaskNotFound       = errors.New("task_not_found")
	ErrTaskLimitReached   = errors.New("task_limit_reached")
	ErrStorageUnavailable = errors.New("task_storage_unavailable")
	ErrInvalidTask        = errors.New("invalid_task")
)

// Task represents the wire and persistence format of a saved task.
type Task struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Prompt    string `json:"prompt"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// Store provides thread-safe, isolated, durable file-based task storage.
type Store struct {
	baseDir string
	root    *os.Root
	mu      sync.RWMutex
}

// NewStore initializes a task store at baseDir, ensuring the directory exists
// with 0700 permissions and can be opened as an os.Root.
func NewStore(baseDir string) (*Store, error) {
	if baseDir == "" {
		return nil, fmt.Errorf("%w: empty base directory", ErrStorageUnavailable)
	}
	absDir, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if err := os.MkdirAll(absDir, 0700); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	info, err := os.Stat(absDir)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("%w: invalid base directory", ErrStorageUnavailable)
	}
	modeChanged := info.Mode().Perm() != 0700
	if modeChanged {
		if err := os.Chmod(absDir, 0700); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
	}
	root, err := os.OpenRoot(absDir)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if modeChanged {
		if err := syncDirectory(root, ".", nil); err != nil {
			_ = root.Close()
			return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
	}
	return &Store{
		baseDir: absDir,
		root:    root,
	}, nil
}

// Close closes the underlying root directory handle.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root != nil {
		err := s.root.Close()
		s.root = nil
		return err
	}
	return nil
}

func ownerDirName(ownerID string) string {
	sum := sha256.Sum256([]byte(ownerID))
	return hex.EncodeToString(sum[:])
}

func isValidTaskID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func generateTaskID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// ExtractTitle derives the task title from the trimmed prompt.
// First nonempty line, capped at 80 Unicode code points.
func ExtractTitle(prompt string) string {
	lines := strings.Split(prompt, "\n")
	firstLine := ""
	for _, l := range lines {
		trimmed := strings.TrimRight(l, "\r\t ")
		trimmed = strings.TrimLeft(trimmed, "\t ")
		if trimmed != "" {
			firstLine = trimmed
			break
		}
	}
	if firstLine == "" {
		firstLine = prompt
	}
	runes := []rune(firstLine)
	if len(runes) > MaxTitleRunes {
		return string(runes[:MaxTitleRunes])
	}
	return string(runes)
}

func syncDirectory(root *os.Root, name string, expected fs.FileInfo) error {
	dir, err := root.Open(name)
	if err != nil {
		return err
	}
	info, statErr := dir.Stat()
	if statErr == nil && (!info.IsDir() || (expected != nil && !os.SameFile(expected, info))) {
		statErr = errors.New("directory changed while opening")
	}
	syncErr := error(nil)
	if statErr == nil {
		syncErr = dir.Sync()
	}
	closeErr := dir.Close()
	if statErr != nil {
		return statErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func (s *Store) ensureOwnerDirectory(ownerRel string, create bool) (bool, error) {
	info, err := s.root.Lstat(ownerRel)
	created := false
	if errors.Is(err, fs.ErrNotExist) {
		if !create {
			return false, nil
		}
		if err := s.root.Mkdir(ownerRel, 0700); err != nil {
			return false, err
		}
		created = true
		info, err = s.root.Lstat(ownerRel)
	}
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return false, errors.New("owner path is not a directory")
	}

	modeChanged := info.Mode().Perm() != 0700
	if modeChanged {
		if err := s.root.Chmod(ownerRel, 0700); err != nil {
			return false, err
		}
		info, err = s.root.Lstat(ownerRel)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return false, errors.New("owner directory changed while setting permissions")
		}
	}
	if created || modeChanged {
		if err := syncDirectory(s.root, ownerRel, info); err != nil {
			return false, err
		}
	}
	if created {
		if err := syncDirectory(s.root, ".", nil); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Create validates the prompt, enforces the per-owner task limit,
// generates a 32-character hex ID, and atomically persists the task.
func (s *Store) Create(ownerID string, rawPrompt string) (*Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.root == nil {
		return nil, ErrStorageUnavailable
	}
	if ownerID == "" {
		return nil, ErrInvalidTask
	}
	if !utf8.ValidString(rawPrompt) {
		return nil, ErrInvalidTask
	}
	trimmedPrompt := strings.TrimSpace(rawPrompt)
	runeCount := utf8.RuneCountInString(trimmedPrompt)
	if runeCount < 1 || runeCount > MaxPromptRunes {
		return nil, ErrInvalidTask
	}

	ownerRel := ownerDirName(ownerID)
	if _, err := s.ensureOwnerDirectory(ownerRel, true); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}

	existing, err := s.listOwnerUnlocked(ownerRel)
	if err != nil {
		return nil, err
	}
	if len(existing) >= MaxTasksPerOwner {
		return nil, ErrTaskLimitReached
	}

	id, err := generateTaskID()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}

	task := &Task{
		ID:        id,
		Title:     ExtractTitle(trimmedPrompt),
		Prompt:    trimmedPrompt,
		Status:    "draft",
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}

	data, err := json.Marshal(task)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}

	fileName := id + ".json"
	relPath := filepath.Join(ownerRel, fileName)
	tempName := fmt.Sprintf(".tmp_%s_%d", id, time.Now().UnixNano())
	tempRelPath := filepath.Join(ownerRel, tempName)

	temp, err := s.root.OpenFile(tempRelPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	tempExists := true
	defer func() {
		if tempExists {
			_ = s.root.Remove(tempRelPath)
		}
	}()

	n, writeErr := temp.Write(data)
	if writeErr == nil && n != len(data) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = temp.Sync()
	}
	closeErr := temp.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, writeErr)
	}
	if err := s.root.Rename(tempRelPath, relPath); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	tempExists = false
	if err := syncDirectory(s.root, ownerRel, nil); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}

	return task, nil
}

// Get retrieves a task by ID for the specified owner.
// If the task does not exist or belongs to another owner, it returns ErrTaskNotFound.
func (s *Store) Get(ownerID, taskID string) (*Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.root == nil {
		return nil, ErrStorageUnavailable
	}
	if ownerID == "" || !isValidTaskID(taskID) {
		return nil, ErrTaskNotFound
	}

	ownerRel := ownerDirName(ownerID)
	exists, err := s.ensureOwnerDirectory(ownerRel, false)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if !exists {
		return nil, ErrTaskNotFound
	}

	task, err := s.readTaskRecord(ownerRel, taskID+".json", taskID)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrTaskNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return task, nil
}

// List returns all tasks for an owner, sorted newest first.
// If no tasks exist, returns an empty (non-nil) slice.
func (s *Store) List(ownerID string) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.root == nil {
		return nil, ErrStorageUnavailable
	}
	if ownerID == "" {
		return []Task{}, nil
	}

	ownerRel := ownerDirName(ownerID)
	exists, err := s.ensureOwnerDirectory(ownerRel, false)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	if !exists {
		return []Task{}, nil
	}
	tasks, err := s.listOwnerUnlocked(ownerRel)
	if err != nil {
		return nil, err
	}
	if tasks == nil {
		return []Task{}, nil
	}
	return tasks, nil
}

func parseTime(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, value)
}

func decodeTaskRecord(data []byte, expectedID string) (*Task, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("record is not valid UTF-8")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()

	var task Task
	if err := decoder.Decode(&task); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("record contains trailing JSON value")
		}
		return nil, err
	}

	promptRunes := utf8.RuneCountInString(task.Prompt)
	_, timeErr := parseTime(task.CreatedAt)
	if !isValidTaskID(task.ID) || task.ID != expectedID ||
		task.Status != "draft" || !utf8.ValidString(task.Prompt) ||
		strings.TrimSpace(task.Prompt) != task.Prompt || promptRunes < 1 || promptRunes > MaxPromptRunes ||
		task.Title != ExtractTitle(task.Prompt) || timeErr != nil {
		return nil, errors.New("invalid task metadata")
	}
	return &task, nil
}

func (s *Store) readTaskRecord(ownerRel, name, expectedID string) (*Task, error) {
	relPath := filepath.Join(ownerRel, name)
	info, err := s.root.Lstat(relPath)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("task path is not a regular file")
	}
	if info.Size() > maxPersistedTaskBytes {
		return nil, errors.New("task record exceeds size limit")
	}

	file, err := s.root.Open(relPath)
	if err != nil {
		return nil, err
	}
	openedInfo, statErr := file.Stat()
	if statErr == nil && (!openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo)) {
		statErr = errors.New("task file changed while opening")
	}
	var data []byte
	if statErr == nil {
		data, statErr = io.ReadAll(io.LimitReader(file, maxPersistedTaskBytes+1))
		if statErr == nil && len(data) > maxPersistedTaskBytes {
			statErr = errors.New("task record exceeds size limit")
		}
	}
	closeErr := file.Close()
	if statErr != nil {
		return nil, statErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return decodeTaskRecord(data, expectedID)
}

func (s *Store) listOwnerUnlocked(ownerRel string) ([]Task, error) {
	entries, err := fs.ReadDir(s.root.FS(), ownerRel)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Task{}, nil
		}
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}

	tasks := make([]Task, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !isValidTaskID(id) {
			continue
		}

		task, err := s.readTaskRecord(ownerRel, name, id)
		if err != nil {
			return nil, fmt.Errorf("%w: corrupt task file %s: %v", ErrStorageUnavailable, name, err)
		}
		tasks = append(tasks, *task)
	}

	// Sort newest first by CreatedAt descending, then ID descending.
	sort.Slice(tasks, func(i, j int) bool {
		ti, _ := parseTime(tasks[i].CreatedAt)
		tj, _ := parseTime(tasks[j].CreatedAt)
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return tasks[i].ID > tasks[j].ID
	})

	return tasks, nil
}
