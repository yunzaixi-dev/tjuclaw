package tjucli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const modifiedFixture = "2026-09-08T12:00:00Z"

func TestListPreservesCursorAndEncodesUnicodePath(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("path"); got != "/课程/计算机视觉" {
			t.Errorf("provider path = %q", got)
		}
		if got := r.URL.Query().Get("next"); got != "opaque+/= cursor" {
			t.Errorf("cursor = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"folder":{"value":[{"name":"资料","size":0,"lastModifiedDateTime":"`+modifiedFixture+`","folder":{"childCount":2}}]},"next":"next+/= opaque"}`)
	}))
	defer server.Close()
	provider := testProvider(t, server)

	result, meta, cliErr := provider.List(context.Background(), "课程//计算机视觉/", "opaque+/= cursor")
	if cliErr != nil {
		t.Fatal(cliErr)
	}
	if len(result.Items) != 1 || result.Items[0].Path != "/课程/计算机视觉/资料" || result.Items[0].Kind != KindFolder {
		t.Fatalf("unexpected items: %#v", result.Items)
	}
	if meta.NextCursor == nil || *meta.NextCursor != "next+/= opaque" {
		t.Fatalf("next cursor = %#v", meta.NextCursor)
	}
}

func TestListRejectsUpstreamAndMalformedResponses(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, body, code string
		status           int
	}{
		{name: "status", status: http.StatusBadGateway, body: "signed-url-secret", code: "upstream_error"},
		{name: "missing folder", status: http.StatusOK, body: `{}`, code: "protocol_error"},
		{name: "missing value", status: http.StatusOK, body: `{"folder":{}}`, code: "protocol_error"},
		{name: "missing size", status: http.StatusOK, body: `{"folder":{"value":[{"name":"x","lastModifiedDateTime":"` + modifiedFixture + `","file":{}}]}}`, code: "protocol_error"},
		{name: "invalid item kind", status: http.StatusOK, body: `{"folder":{"value":[{"name":"x","size":1,"lastModifiedDateTime":"` + modifiedFixture + `"}]}}`, code: "protocol_error"},
		{name: "invalid kind metadata", status: http.StatusOK, body: `{"folder":{"value":[{"name":"x","size":1,"lastModifiedDateTime":"` + modifiedFixture + `","file":"not-an-object"}]}}`, code: "protocol_error"},
		{name: "invalid time", status: http.StatusOK, body: `{"folder":{"value":[{"name":"x","size":1,"lastModifiedDateTime":"never","file":{}}]}}`, code: "protocol_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				io.WriteString(w, test.body)
			}))
			defer server.Close()
			_, _, cliErr := testProvider(t, server).List(context.Background(), "/", "")
			if cliErr == nil || cliErr.Code != test.code {
				t.Fatalf("error = %#v, want code %s", cliErr, test.code)
			}
			if strings.Contains(cliErr.Message, "secret") {
				t.Fatalf("error leaked response body: %q", cliErr.Message)
			}
		})
	}
}

func TestProviderPathValidation(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"/../secret", "/a/./b", "/a\\b", "/a\x00b", "/a\nb", "/" + strings.Repeat("x", maxProviderPathBytes)} {
		if _, err := normalizeProviderPath(value); err == nil {
			t.Errorf("normalizeProviderPath(%q) succeeded", value)
		}
	}
	if got, err := normalizeProviderPath("课程/视觉/"); err != nil || got != "/课程/视觉" {
		t.Fatalf("normalized = %q, err = %v", got, err)
	}
}

func TestSearchScansRootAndReportsCompleteness(t *testing.T) {
	t.Parallel()
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("path") != "/" {
			t.Errorf("search path = %q", r.URL.Query().Get("path"))
		}
		cursor := r.URL.Query().Get("next")
		requested = append(requested, cursor)
		if cursor == "" {
			io.WriteString(w, catalogPage("c1", folderFixture("高等数学")))
			return
		}
		io.WriteString(w, catalogPage("", folderFixture("计算机视觉")))
	}))
	defer server.Close()

	result, meta, cliErr := testProvider(t, server).Search(context.Background(), "计算机", 20, 50)
	if cliErr != nil {
		t.Fatal(cliErr)
	}
	if len(result.Items) != 1 || result.Items[0].Name != "计算机视觉" {
		t.Fatalf("matches = %#v", result.Items)
	}
	if meta.Scope != "course-catalog" || meta.PagesScanned != 2 || meta.Incomplete {
		t.Fatalf("meta = %#v", meta)
	}
	if strings.Join(requested, ",") != ",c1" {
		t.Fatalf("requested cursors = %#v", requested)
	}
}

func TestSearchDetectsRepeatedCursor(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next := "repeat"
		if r.URL.Query().Get("next") == "repeat" {
			next = "repeat"
		}
		io.WriteString(w, catalogPage(next, folderFixture("other")))
	}))
	defer server.Close()

	_, _, cliErr := testProvider(t, server).Search(context.Background(), "missing", 20, 50)
	if cliErr == nil || cliErr.Code != "protocol_error" {
		t.Fatalf("error = %#v", cliErr)
	}
}

func TestSearchReportsPageAndResultTruncation(t *testing.T) {
	t.Parallel()
	t.Run("page cap", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, catalogPage("more", folderFixture("match")))
		}))
		defer server.Close()
		result, meta, cliErr := testProvider(t, server).Search(context.Background(), "match", 1, 50)
		if cliErr != nil || len(result.Items) != 1 || meta.PagesScanned != 1 || !meta.Incomplete {
			t.Fatalf("result=%#v meta=%#v err=%v", result, meta, cliErr)
		}
	})
	t.Run("result cap", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, catalogPage("", folderFixture("match one"), folderFixture("match two")))
		}))
		defer server.Close()
		result, meta, cliErr := testProvider(t, server).Search(context.Background(), "match", 20, 1)
		if cliErr != nil || len(result.Items) != 1 || !meta.Incomplete {
			t.Fatalf("result=%#v meta=%#v err=%v", result, meta, cliErr)
		}
	})
}

func TestSearchValidatesQueryAndBounds(t *testing.T) {
	t.Parallel()
	provider, err := newProvider(&http.Client{}, "https://cs.tjuse.com", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		query           string
		maxPages, limit int
	}{
		{" ", 20, 50},
		{strings.Repeat("界", 257), 20, 50},
		{"x", 0, 50},
		{"x", 20, 1001},
	} {
		_, _, cliErr := provider.Search(context.Background(), test.query, test.maxPages, test.limit)
		if cliErr == nil || cliErr.Code != "invalid_argument" || cliErr.ExitCode != 2 {
			t.Errorf("Search(%q, %d, %d) error = %#v", test.query, test.maxPages, test.limit, cliErr)
		}
	}
}

func TestDownloadFollowsAllowedRedirectAndPublishesChecksum(t *testing.T) {
	t.Parallel()
	const content = "tiny fixture"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/raw/":
			if got := r.URL.Query().Get("path"); got != "/课程/README.md" {
				t.Errorf("download path = %q", got)
			}
			http.Redirect(w, r, "/blob", http.StatusTemporaryRedirect)
		case "/blob":
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, content)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	output := filepath.Join(t.TempDir(), "README.md")

	result, cliErr := testProvider(t, server).Download(context.Background(), "/课程/README.md", output, 100)
	if cliErr != nil {
		t.Fatal(cliErr)
	}
	wantHash := sha256.Sum256([]byte(content))
	if result.LocalPath != output || result.Bytes != int64(len(content)) || result.SHA256 != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("result = %#v", result)
	}
	body, err := os.ReadFile(output)
	if err != nil || string(body) != content {
		t.Fatalf("file = %q, err = %v", body, err)
	}
	assertNoTemporaryDownloads(t, filepath.Dir(output))
}

func TestDownloadRejectsUnsafeRedirectWithoutLeakingURL(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://evil.example/signed?token=secret", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	directory := t.TempDir()
	output := filepath.Join(directory, "file")

	_, cliErr := testProvider(t, server).Download(context.Background(), "/file", output, 100)
	if cliErr == nil || cliErr.Code != "unsafe_redirect" {
		t.Fatalf("error = %#v", cliErr)
	}
	if strings.Contains(cliErr.Message, "evil") || strings.Contains(cliErr.Message, "secret") {
		t.Fatalf("redirect URL leaked: %q", cliErr.Message)
	}
	if _, err := os.Lstat(output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target exists after failure: %v", err)
	}
	assertNoTemporaryDownloads(t, directory)
}

func TestRedirectPolicyRestrictsSchemeHostAndCount(t *testing.T) {
	t.Parallel()
	provider, err := newProvider(&http.Client{}, "https://cs.tjuse.com", false)
	if err != nil {
		t.Fatal(err)
	}
	allowed, _ := http.NewRequest(http.MethodGet, "https://tenant.microsoftpersonalcontent.com/file", nil)
	if err := provider.checkRedirect(allowed, []*http.Request{{}}); err != nil {
		t.Fatalf("known Microsoft host rejected: %v", err)
	}
	for _, rawURL := range []string{
		"http://tenant.microsoftpersonalcontent.com/file",
		"https://evilmicrosoftpersonalcontent.com/file",
		"https://example.com/file",
	} {
		req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
		if err := provider.checkRedirect(req, []*http.Request{{}}); err == nil {
			t.Errorf("redirect %q accepted", rawURL)
		}
	}
	via := make([]*http.Request, 6)
	if err := provider.checkRedirect(allowed, via); err == nil {
		t.Error("sixth redirect accepted")
	}
}

func TestDownloadRejectsExistingFileAndSymlink(t *testing.T) {
	t.Parallel()
	provider, err := newProvider(&http.Client{}, "https://cs.tjuse.com", false)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	regular := filepath.Join(directory, "regular")
	if err := os.WriteFile(regular, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "symlink")
	if err := os.Symlink(filepath.Join(directory, "missing"), symlink); err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{regular, symlink} {
		_, cliErr := provider.Download(context.Background(), "/file", output, 100)
		if cliErr == nil || cliErr.Code != "target_exists" {
			t.Errorf("Download to %q error = %#v", output, cliErr)
		}
	}
	body, _ := os.ReadFile(regular)
	if string(body) != "keep" {
		t.Fatalf("existing file changed to %q", body)
	}
}

func TestDownloadEnforcesSizeAndRejectsHTML(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, contentType, body, code string
		flush                         bool
	}{
		{name: "declared size", contentType: "application/octet-stream", body: "12345", code: "size_limit_exceeded"},
		{name: "streamed size", contentType: "application/octet-stream", body: "12345", code: "size_limit_exceeded", flush: true},
		{name: "html", contentType: "text/html; charset=utf-8", body: "<html></html>", code: "protocol_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", test.contentType)
				if test.flush {
					w.(http.Flusher).Flush()
				}
				io.WriteString(w, test.body)
			}))
			defer server.Close()
			directory := t.TempDir()
			output := filepath.Join(directory, "file")
			maxBytes := int64(100)
			if test.code == "size_limit_exceeded" {
				maxBytes = 4
			}
			_, cliErr := testProvider(t, server).Download(context.Background(), "/file", output, maxBytes)
			if cliErr == nil || cliErr.Code != test.code {
				t.Fatalf("error = %#v", cliErr)
			}
			if _, err := os.Lstat(output); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("target exists after failure: %v", err)
			}
			assertNoTemporaryDownloads(t, directory)
		})
	}
}

func TestDownloadCleansPartialFileAfterInterruptedStream(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"application/octet-stream"}},
			Body:          io.NopCloser(&failingReader{data: []byte("abc")}),
			ContentLength: 6,
			Request:       req,
		}, nil
	})}
	provider, err := newProvider(client, "https://cs.tjuse.com", false)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	output := filepath.Join(directory, "file")
	_, cliErr := provider.Download(context.Background(), "/file", output, 100)
	if cliErr == nil || cliErr.Code != "download_failed" {
		t.Fatalf("error = %#v", cliErr)
	}
	if _, err := os.Lstat(output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target exists after failure: %v", err)
	}
	assertNoTemporaryDownloads(t, directory)
}

func testProvider(t *testing.T, server *httptest.Server) *Provider {
	t.Helper()
	provider, err := newProvider(server.Client(), server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func folderFixture(name string) string {
	return `{"name":"` + name + `","size":0,"lastModifiedDateTime":"` + modifiedFixture + `","folder":{"childCount":0}}`
}

func catalogPage(next string, items ...string) string {
	result := `{"folder":{"value":[` + strings.Join(items, ",") + `]}`
	if next != "" {
		result += `,"next":"` + next + `"`
	}
	return result + `}`
}

func assertNoTemporaryDownloads(t *testing.T, directory string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(directory, ".tjucli-download-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary downloads remain: %#v", matches)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type failingReader struct {
	data []byte
	done bool
}

func (reader *failingReader) Read(buffer []byte) (int, error) {
	if reader.done {
		return 0, io.ErrUnexpectedEOF
	}
	reader.done = true
	return copy(buffer, reader.data), nil
}
