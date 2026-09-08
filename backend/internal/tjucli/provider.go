package tjucli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxCatalogResponseBytes = int64(4 << 20)
	maxProviderPathBytes    = 4096
	maxCursorBytes          = 8192
)

type Provider struct {
	client        *http.Client
	baseURL       *url.URL
	allowInsecure bool
}

// NewProvider constructs the fixed public course-sharing provider.
func NewProvider() (*Provider, error) {
	return newProvider(&http.Client{Timeout: 20 * time.Second}, DefaultBaseURL, false)
}

// newProvider keeps test-only transport and endpoint injection out of the CLI.
func newProvider(client *http.Client, baseURL string, allowInsecure bool) (*Provider, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("invalid provider base URL")
	}
	if parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http") {
		return nil, errors.New("provider base URL must use HTTPS")
	}
	if client == nil {
		client = &http.Client{}
	}
	clone := *client
	if clone.Timeout <= 0 {
		clone.Timeout = 20 * time.Second
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	provider := &Provider{client: &clone, baseURL: parsed, allowInsecure: allowInsecure}
	clone.CheckRedirect = provider.checkRedirect
	return provider, nil
}

type upstreamItem struct {
	Name       string          `json:"name"`
	Size       *int64          `json:"size"`
	ModifiedAt string          `json:"lastModifiedDateTime"`
	File       json.RawMessage `json:"file"`
	Folder     json.RawMessage `json:"folder"`
}

type upstreamList struct {
	Folder *struct {
		Value *[]upstreamItem `json:"value"`
	} `json:"folder"`
	Next *string `json:"next"`
}

func (p *Provider) List(ctx context.Context, providerPath, cursor string) (ListResult, ListMeta, *CLIError) {
	normalized, err := normalizeProviderPath(providerPath)
	if err != nil {
		return ListResult{}, ListMeta{}, NewFlagError(err.Error())
	}
	if len(cursor) > maxCursorBytes {
		return ListResult{}, ListMeta{}, NewFlagError("cursor is too long")
	}
	values := url.Values{"path": []string{normalized}}
	if cursor != "" {
		values.Set("next", cursor)
	}
	requestURL := p.endpoint("/api/", values)
	req, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if requestErr != nil {
		return ListResult{}, ListMeta{}, NewRuntimeError("protocol_error", "could not create provider request")
	}
	req.Header.Set("Accept", "application/json")
	resp, requestErr := p.client.Do(req)
	if requestErr != nil {
		return ListResult{}, ListMeta{}, NewRuntimeError("upstream_error", "course provider request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ListResult{}, ListMeta{}, NewRuntimeError("upstream_error", fmt.Sprintf("course provider returned HTTP %d", resp.StatusCode))
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxCatalogResponseBytes+1))
	if readErr != nil {
		return ListResult{}, ListMeta{}, NewRuntimeError("upstream_error", "course provider response could not be read")
	}
	if int64(len(body)) > maxCatalogResponseBytes {
		return ListResult{}, ListMeta{}, NewRuntimeError("protocol_error", "course provider response is too large")
	}
	var payload upstreamList
	if json.Unmarshal(body, &payload) != nil || payload.Folder == nil || payload.Folder.Value == nil {
		return ListResult{}, ListMeta{}, NewRuntimeError("protocol_error", "course provider returned a malformed catalog response")
	}

	items := make([]Item, 0, len(*payload.Folder.Value))
	for _, remote := range *payload.Folder.Value {
		item, normalizeErr := normalizeItem(normalized, remote)
		if normalizeErr != nil {
			return ListResult{}, ListMeta{}, NewRuntimeError("protocol_error", "course provider returned a malformed catalog item")
		}
		items = append(items, item)
	}
	var next *string
	if payload.Next != nil && *payload.Next != "" {
		value := *payload.Next
		next = &value
	}
	return ListResult{Items: items}, ListMeta{NextCursor: next}, nil
}

func (p *Provider) Search(ctx context.Context, query string, maxPages, limit int) (SearchResult, SearchMeta, *CLIError) {
	if !utf8.ValidString(query) || strings.TrimSpace(query) == "" {
		return SearchResult{}, SearchMeta{}, NewFlagError("search query must not be empty")
	}
	if utf8.RuneCountInString(query) > 256 {
		return SearchResult{}, SearchMeta{}, NewFlagError("search query must not exceed 256 Unicode characters")
	}
	if maxPages < 1 || maxPages > MaximumSearchPages {
		return SearchResult{}, SearchMeta{}, NewFlagError(fmt.Sprintf("max-pages must be between 1 and %d", MaximumSearchPages))
	}
	if limit < 1 || limit > MaximumSearchLimit {
		return SearchResult{}, SearchMeta{}, NewFlagError(fmt.Sprintf("limit must be between 1 and %d", MaximumSearchLimit))
	}

	meta := SearchMeta{Scope: "course-catalog"}
	matches := make([]Item, 0, min(limit, 64))
	needle := strings.ToLower(query)
	cursor := ""
	seen := make(map[string]struct{})
	for meta.PagesScanned < maxPages {
		page, pageMeta, listErr := p.List(ctx, "/", cursor)
		if listErr != nil {
			return SearchResult{}, SearchMeta{}, listErr
		}
		meta.PagesScanned++
		for _, item := range page.Items {
			if !strings.Contains(strings.ToLower(item.Name), needle) {
				continue
			}
			if len(matches) == limit {
				meta.Incomplete = true
				return SearchResult{Items: matches}, meta, nil
			}
			matches = append(matches, item)
		}
		if pageMeta.NextCursor == nil {
			return SearchResult{Items: matches}, meta, nil
		}
		next := *pageMeta.NextCursor
		if next == cursor {
			return SearchResult{}, SearchMeta{}, NewRuntimeError("protocol_error", "course provider repeated a catalog cursor")
		}
		if _, exists := seen[next]; exists {
			return SearchResult{}, SearchMeta{}, NewRuntimeError("protocol_error", "course provider repeated a catalog cursor")
		}
		seen[next] = struct{}{}
		cursor = next
	}
	meta.Incomplete = cursor != ""
	return SearchResult{Items: matches}, meta, nil
}

func (p *Provider) Download(ctx context.Context, providerPath, outputPath string, maxBytes int64) (DownloadResult, *CLIError) {
	normalized, err := normalizeProviderPath(providerPath)
	if err != nil {
		return DownloadResult{}, NewFlagError(err.Error())
	}
	if normalized == "/" {
		return DownloadResult{}, NewFlagError("download path must identify a file")
	}
	if outputPath == "" {
		return DownloadResult{}, NewFlagError("output path must not be empty")
	}
	if maxBytes < 1 || maxBytes > MaximumDownloadBytes {
		return DownloadResult{}, NewFlagError(fmt.Sprintf("max-bytes must be between 1 and %d", MaximumDownloadBytes))
	}
	absoluteOutput, absErr := filepath.Abs(outputPath)
	if absErr != nil {
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not resolve output path")
	}
	if _, statErr := os.Lstat(absoluteOutput); statErr == nil {
		return DownloadResult{}, NewRuntimeError("target_exists", "output target already exists")
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not inspect output target")
	}

	temp, createErr := os.CreateTemp(filepath.Dir(absoluteOutput), ".tjucli-download-*")
	if createErr != nil {
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not create temporary output file")
	}
	tempPath := temp.Name()
	published := false
	defer func() {
		_ = temp.Close()
		if !published {
			_ = os.Remove(tempPath)
		}
	}()

	values := url.Values{"path": []string{normalized}}
	req, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, p.endpoint("/api/raw/", values), nil)
	if requestErr != nil {
		return DownloadResult{}, NewRuntimeError("protocol_error", "could not create download request")
	}
	req.Header.Set("Accept", "application/octet-stream")
	downloadClient := *p.client
	downloadClient.CheckRedirect = p.checkRedirect
	resp, requestErr := downloadClient.Do(req)
	if requestErr != nil {
		var redirectErr *redirectPolicyError
		if errors.As(requestErr, &redirectErr) {
			return DownloadResult{}, NewRuntimeError("unsafe_redirect", redirectErr.message)
		}
		return DownloadResult{}, NewRuntimeError("download_failed", "course download request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return DownloadResult{}, NewRuntimeError("upstream_error", fmt.Sprintf("course provider returned HTTP %d", resp.StatusCode))
	}
	if isHTML(resp.Header.Get("Content-Type")) {
		return DownloadResult{}, NewRuntimeError("protocol_error", "course provider returned HTML instead of a file")
	}
	if resp.ContentLength > maxBytes {
		return DownloadResult{}, NewRuntimeError("size_limit_exceeded", "download exceeds max-bytes")
	}

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(resp.Body, maxBytes+1))
	if copyErr != nil {
		return DownloadResult{}, NewRuntimeError("download_failed", "course download was interrupted")
	}
	if written > maxBytes {
		return DownloadResult{}, NewRuntimeError("size_limit_exceeded", "download exceeds max-bytes")
	}
	if resp.ContentLength >= 0 && written != resp.ContentLength {
		return DownloadResult{}, NewRuntimeError("download_failed", "course download length did not match the declared length")
	}
	if syncErr := temp.Sync(); syncErr != nil {
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not flush downloaded file")
	}
	if closeErr := temp.Close(); closeErr != nil {
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not close downloaded file")
	}
	if linkErr := os.Link(tempPath, absoluteOutput); linkErr != nil {
		if _, statErr := os.Lstat(absoluteOutput); statErr == nil {
			return DownloadResult{}, NewRuntimeError("target_exists", "output target already exists")
		}
		return DownloadResult{}, NewRuntimeError("filesystem_error", "could not publish downloaded file")
	}
	published = true
	_ = os.Remove(tempPath)
	return DownloadResult{LocalPath: absoluteOutput, Bytes: written, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (p *Provider) endpoint(endpointPath string, values url.Values) string {
	result := *p.baseURL
	result.Path = strings.TrimRight(p.baseURL.Path, "/") + endpointPath
	result.RawQuery = values.Encode()
	return result.String()
}

type redirectPolicyError struct{ message string }

func (e *redirectPolicyError) Error() string { return e.message }

func (p *Provider) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > 5 {
		return &redirectPolicyError{message: "download exceeded the redirect limit"}
	}
	if req.URL.Scheme != "https" && !(p.allowInsecure && req.URL.Scheme == "http") {
		return &redirectPolicyError{message: "download redirect must use HTTPS"}
	}
	if !p.allowedDownloadHost(req.URL.Hostname()) {
		return &redirectPolicyError{message: "download redirect host is not allowed"}
	}
	return nil
}

func (p *Provider) allowedDownloadHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	baseHost := strings.ToLower(strings.TrimSuffix(p.baseURL.Hostname(), "."))
	if host == baseHost || host == "cs.tjuse.com" {
		return true
	}
	for _, domain := range []string{
		"microsoftpersonalcontent.com",
		"files.1drv.com",
		"storage.live.com",
	} {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return host == "onedrive.live.com"
}

func normalizeProviderPath(value string) (string, error) {
	if value == "" {
		value = "/"
	}
	if len(value) > maxProviderPathBytes {
		return "", errors.New("provider path is too long")
	}
	if !utf8.ValidString(value) {
		return "", errors.New("provider path must be valid UTF-8")
	}
	if strings.ContainsRune(value, '\\') {
		return "", errors.New("provider path must not contain backslashes")
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", errors.New("provider path must not contain control characters")
		}
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return "", errors.New("provider path must not contain traversal segments")
		}
	}
	normalized := path.Clean("/" + strings.TrimPrefix(value, "/"))
	return normalized, nil
}

func normalizeItem(parent string, remote upstreamItem) (Item, error) {
	if remote.Name == "" || remote.Name == "." || remote.Name == ".." || !utf8.ValidString(remote.Name) || strings.ContainsAny(remote.Name, "/\\") {
		return Item{}, errors.New("invalid item name")
	}
	for _, character := range remote.Name {
		if unicode.IsControl(character) {
			return Item{}, errors.New("invalid item name")
		}
	}
	if remote.Size == nil || *remote.Size < 0 {
		return Item{}, errors.New("invalid item size")
	}
	if remote.ModifiedAt == "" {
		return Item{}, errors.New("missing modification time")
	}
	if _, err := time.Parse(time.RFC3339, remote.ModifiedAt); err != nil {
		return Item{}, errors.New("invalid modification time")
	}
	filePresent := validJSONObject(remote.File)
	folderPresent := validJSONObject(remote.Folder)
	if filePresent == folderPresent {
		return Item{}, errors.New("ambiguous item kind")
	}
	if (len(remote.File) > 0 && string(remote.File) != "null" && !filePresent) ||
		(len(remote.Folder) > 0 && string(remote.Folder) != "null" && !folderPresent) {
		return Item{}, errors.New("invalid item metadata")
	}
	kind := KindFile
	if folderPresent {
		kind = KindFolder
	}
	return Item{
		Name:       remote.Name,
		Path:       path.Join(parent, remote.Name),
		Kind:       kind,
		Size:       *remote.Size,
		ModifiedAt: remote.ModifiedAt,
	}, nil
}

func validJSONObject(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

func isHTML(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == "text/html" || mediaType == "application/xhtml+xml"
}
