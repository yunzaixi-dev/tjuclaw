package task

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStoreCreateListGet(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	owner1 := "user-1"
	owner2 := "user-2"

	// Initial list should be empty slice, not nil
	tasks, err := store.List(owner1)
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if tasks == nil || len(tasks) != 0 {
		t.Fatalf("expected empty non-nil slice, got: %#v", tasks)
	}

	// Create task 1
	prompt1 := "First line of prompt 1\nSecond line"
	t1, err := store.Create(owner1, prompt1)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if t1.ID == "" || len(t1.ID) != 32 {
		t.Fatalf("expected 32-char hex ID, got %s", t1.ID)
	}
	if t1.Title != "First line of prompt 1" {
		t.Fatalf("unexpected title: %s", t1.Title)
	}
	if t1.Prompt != prompt1 {
		t.Fatalf("unexpected prompt: %s", t1.Prompt)
	}
	if t1.Status != "draft" {
		t.Fatalf("unexpected status: %s", t1.Status)
	}
	if _, err := time.Parse(time.RFC3339, t1.CreatedAt); err != nil {
		t.Fatalf("invalid RFC3339 timestamp: %s", t1.CreatedAt)
	}

	// Slight delay to test ordering
	time.Sleep(10 * time.Millisecond)

	// Create task 2
	prompt2 := "Task 2 single line"
	t2, err := store.Create(owner1, prompt2)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// List owner 1: should have 2 tasks, newest first (t2 then t1)
	tasks, err = store.List(owner1)
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
	if tasks[0].ID != t2.ID || tasks[1].ID != t1.ID {
		t.Fatalf("expected [t2, t1], got [%s, %s]", tasks[0].ID, tasks[1].ID)
	}

	// Get t1
	got1, err := store.Get(owner1, t1.ID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got1.ID != t1.ID || got1.Title != t1.Title || got1.Prompt != t1.Prompt {
		t.Fatalf("mismatched retrieved task: %#v vs %#v", got1, t1)
	}

	// Cross-owner isolation: owner2 cannot read owner1's task
	_, err = store.Get(owner2, t1.ID)
	if err == nil || err != ErrTaskNotFound {
		t.Fatalf("expected ErrTaskNotFound for cross-owner get, got %v", err)
	}

	// Owner2 list should be empty
	tasks2, err := store.List(owner2)
	if err != nil {
		t.Fatalf("owner2 List failed: %v", err)
	}
	if len(tasks2) != 0 {
		t.Fatalf("expected 0 tasks for owner2, got %d", len(tasks2))
	}
}

func TestStoreTitleExtraction(t *testing.T) {
	cases := []struct {
		prompt string
		want   string
	}{
		{"Simple title", "Simple title"},
		{"\n\n  Indented first line  \nSecond line", "Indented first line"},
		{"Line 1\r\nLine 2", "Line 1"},
		{strings.Repeat("测", 90), strings.Repeat("测", 80)},
		{strings.Repeat("a", 100), strings.Repeat("a", 80)},
	}

	for _, c := range cases {
		got := ExtractTitle(c.prompt)
		if got != c.want {
			t.Errorf("ExtractTitle(%q) = %q, want %q", c.prompt, got, c.want)
		}
	}
}

func TestStoreRestart(t *testing.T) {
	dir := t.TempDir()

	// Instance 1
	store1, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store1: %v", err)
	}
	t1, err := store1.Create("owner-restart", "Durable task before restart")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	store1.Close()

	// Instance 2 on same directory
	store2, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store2: %v", err)
	}
	defer store2.Close()

	got, err := store2.Get("owner-restart", t1.ID)
	if err != nil {
		t.Fatalf("Get after restart failed: %v", err)
	}
	if got.ID != t1.ID || got.Prompt != t1.Prompt {
		t.Fatalf("data altered after restart: %#v", got)
	}

	list, err := store2.List("owner-restart")
	if err != nil {
		t.Fatalf("List after restart failed: %v", err)
	}
	if len(list) != 1 || list[0].ID != t1.ID {
		t.Fatalf("unexpected list after restart: %#v", list)
	}
}

func TestStoreConcurrency(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	const numGoroutines = 20
	const tasksPerGoroutine = 10
	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		go func(gID int) {
			defer wg.Done()
			owner := fmt.Sprintf("concurrency-owner-%d", gID%4)
			for j := 0; j < tasksPerGoroutine; j++ {
				prompt := fmt.Sprintf("Goroutine %d Task %d", gID, j)
				task, err := store.Create(owner, prompt)
				if err != nil {
					t.Errorf("Create failed in goroutine: %v", err)
					return
				}
				// Read it back
				if _, err := store.Get(owner, task.ID); err != nil {
					t.Errorf("Get failed in goroutine: %v", err)
					return
				}
				// List
				if _, err := store.List(owner); err != nil {
					t.Errorf("List failed in goroutine: %v", err)
					return
				}
			}
		}(i)
	}

	wg.Wait()

	// Verify counts for each of the 4 owners
	total := 0
	for o := 0; o < 4; o++ {
		owner := fmt.Sprintf("concurrency-owner-%d", o)
		list, err := store.List(owner)
		if err != nil {
			t.Fatalf("List failed: %v", err)
		}
		// Each owner was written by (numGoroutines / 4) goroutines = 5 goroutines * 10 = 50 tasks
		if len(list) != 50 {
			t.Fatalf("expected 50 tasks for %s, got %d", owner, len(list))
		}
		total += len(list)
	}
	if total != numGoroutines*tasksPerGoroutine {
		t.Fatalf("expected %d total tasks, got %d", numGoroutines*tasksPerGoroutine, total)
	}
}

func TestStoreCorruptionFailClosed(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	owner := "corrupt-owner"
	t1, err := store.Create(owner, "Task to be corrupted")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	ownerRel := ownerDirName(owner)
	taskFile := filepath.Join(dir, ownerRel, t1.ID+".json")

	// Overwrite task file with invalid JSON
	if err := os.WriteFile(taskFile, []byte("{corrupt json"), 0600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	// Get should fail with storage unavailable
	if _, err := store.Get(owner, t1.ID); err == nil {
		t.Fatal("expected error on corrupt file, got nil")
	}

	// List should fail closed with storage unavailable
	if _, err := store.List(owner); err == nil {
		t.Fatal("expected error on corrupt file list, got nil")
	}
}

func TestStoreTaskLimit(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	owner := "limit-owner"
	ownerRel := ownerDirName(owner)
	ownerDir := filepath.Join(dir, ownerRel)
	if err := os.MkdirAll(ownerDir, 0700); err != nil {
		t.Fatal(err)
	}

	// Fake 1000 tasks directly
	for i := 0; i < MaxTasksPerOwner; i++ {
		id := fmt.Sprintf("%032x", i)
		content := fmt.Sprintf(`{"id":"%s","title":"fake","prompt":"fake","status":"draft","created_at":"2026-01-01T00:00:00Z"}`, id)
		if err := os.WriteFile(filepath.Join(ownerDir, id+".json"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}

	// 1001st create should fail with ErrTaskLimitReached
	_, err = store.Create(owner, "One more task")
	if err != ErrTaskLimitReached {
		t.Fatalf("expected ErrTaskLimitReached, got %v", err)
	}
}

func TestStoreTraversalAndInvalidIDs(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Try path traversal IDs
	badIDs := []string{
		"../escape",
		"../../etc/passwd",
		"0123456789abcdef0123456789abcdef/extra",
		"0123456789ABCDEF0123456789ABCDEF", // uppercase not allowed
		"short",
		strings.Repeat("a", 33),
	}

	for _, badID := range badIDs {
		_, err := store.Get("user", badID)
		if err != ErrTaskNotFound {
			t.Errorf("Get(%q) error = %v, want %v", badID, err, ErrTaskNotFound)
		}
	}
}

func TestStorePermissions(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	owner := "perm-owner"
	t1, err := store.Create(owner, "Test permissions")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	ownerRel := ownerDirName(owner)
	ownerDir := filepath.Join(dir, ownerRel)
	taskFile := filepath.Join(ownerDir, t1.ID+".json")

	dirStat, err := os.Stat(ownerDir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirStat.Mode().Perm(); perm != 0700 {
		t.Fatalf("owner dir perm = %o, want 0700", perm)
	}

	fileStat, err := os.Stat(taskFile)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fileStat.Mode().Perm(); perm != 0600 {
		t.Fatalf("task file perm = %o, want 0600", perm)
	}
}

func TestStoreTightensExistingDirectoryModes(t *testing.T) {
	baseDir := filepath.Join(t.TempDir(), "tasks")
	if err := os.Mkdir(baseDir, 0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(baseDir, 0777); err != nil {
		t.Fatal(err)
	}

	owner := "existing-mode-owner"
	ownerDir := filepath.Join(baseDir, ownerDirName(owner))
	if err := os.Mkdir(ownerDir, 0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ownerDir, 0777); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(baseDir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer store.Close()

	baseInfo, err := os.Stat(baseDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := baseInfo.Mode().Perm(); got != 0700 {
		t.Fatalf("base directory mode = %o, want 0700", got)
	}

	if _, err := store.Create(owner, "repair existing owner mode"); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	ownerInfo, err := os.Stat(ownerDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := ownerInfo.Mode().Perm(); got != 0700 {
		t.Fatalf("owner directory mode = %o, want 0700", got)
	}
}

func TestStoreRejectsMalformedPersistedMetadata(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	valid := Task{
		ID:        id,
		Title:     "valid prompt",
		Prompt:    "valid prompt",
		Status:    "draft",
		CreatedAt: "2026-01-01T00:00:00Z",
	}
	encode := func(t *testing.T, task Task) []byte {
		t.Helper()
		data, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}

	tests := map[string][]byte{}
	wrongID := valid
	wrongID.ID = "fedcba9876543210fedcba9876543210"
	tests["ID does not match filename"] = encode(t, wrongID)
	wrongStatus := valid
	wrongStatus.Status = "done"
	tests["status is not draft"] = encode(t, wrongStatus)
	emptyPrompt := valid
	emptyPrompt.Prompt = ""
	emptyPrompt.Title = ""
	tests["prompt is empty"] = encode(t, emptyPrompt)
	untrimmedPrompt := valid
	untrimmedPrompt.Prompt = " valid prompt "
	tests["prompt is not trimmed"] = encode(t, untrimmedPrompt)
	longPrompt := valid
	longPrompt.Prompt = strings.Repeat("x", MaxPromptRunes+1)
	longPrompt.Title = strings.Repeat("x", MaxTitleRunes)
	tests["prompt has too many runes"] = encode(t, longPrompt)
	wrongTitle := valid
	wrongTitle.Title = "not derived"
	tests["title is not derived"] = encode(t, wrongTitle)
	badTime := valid
	badTime.CreatedAt = "yesterday"
	tests["timestamp is not RFC3339"] = encode(t, badTime)
	tests["unknown field"] = []byte(`{"id":"0123456789abcdef0123456789abcdef","title":"valid prompt","prompt":"valid prompt","status":"draft","created_at":"2026-01-01T00:00:00Z","extra":true}`)
	tests["trailing value"] = append(encode(t, valid), []byte(` {}`)...)
	tests["invalid UTF-8"] = append(encode(t, valid), 0xff)

	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			owner := "malformed-owner"
			ownerDir := filepath.Join(dir, ownerDirName(owner))
			if err := os.MkdirAll(ownerDir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(ownerDir, id+".json"), data, 0600); err != nil {
				t.Fatal(err)
			}

			store, err := NewStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()

			if _, err := store.Get(owner, id); !errors.Is(err, ErrStorageUnavailable) {
				t.Fatalf("Get error = %v, want ErrStorageUnavailable", err)
			}
			if _, err := store.List(owner); !errors.Is(err, ErrStorageUnavailable) {
				t.Fatalf("List error = %v, want ErrStorageUnavailable", err)
			}
		})
	}
}

func TestStoreRejectsOversizedPersistedRecord(t *testing.T) {
	dir := t.TempDir()
	owner := "oversized-owner"
	const id = "0123456789abcdef0123456789abcdef"
	ownerDir := filepath.Join(dir, ownerDirName(owner))
	if err := os.MkdirAll(ownerDir, 0700); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, maxPersistedTaskBytes+1)
	if err := os.WriteFile(filepath.Join(ownerDir, id+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.Get(owner, id); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Get error = %v, want ErrStorageUnavailable", err)
	}
	if _, err := store.List(owner); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("List error = %v, want ErrStorageUnavailable", err)
	}
}

func TestStoreRejectsOwnerDirectorySymlink(t *testing.T) {
	dir := t.TempDir()
	owner := "symlink-owner"
	if err := os.Mkdir(filepath.Join(dir, "target"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target", filepath.Join(dir, ownerDirName(owner))); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.Create(owner, "must not follow owner link"); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Create error = %v, want ErrStorageUnavailable", err)
	}
	if _, err := store.List(owner); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("List error = %v, want ErrStorageUnavailable", err)
	}
}

func TestStoreRejectsRecordSymlink(t *testing.T) {
	dir := t.TempDir()
	owner := "record-symlink-owner"
	const id = "0123456789abcdef0123456789abcdef"
	ownerDir := filepath.Join(dir, ownerDirName(owner))
	if err := os.MkdirAll(ownerDir, 0700); err != nil {
		t.Fatal(err)
	}
	target := `.record-target`
	data := fmt.Sprintf(`{"id":%q,"title":"valid prompt","prompt":"valid prompt","status":"draft","created_at":"2026-01-01T00:00:00Z"}`, id)
	if err := os.WriteFile(filepath.Join(ownerDir, target), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(ownerDir, id+".json")); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.Get(owner, id); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Get error = %v, want ErrStorageUnavailable", err)
	}
	if _, err := store.List(owner); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("List error = %v, want ErrStorageUnavailable", err)
	}
}
