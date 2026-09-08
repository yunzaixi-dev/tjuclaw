package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/tjucli"
)

type fakeProvider struct {
	listPath       string
	listCursor     string
	searchQuery    string
	searchMaxPages int
	searchLimit    int
	downloadPath   string
	downloadOutput string
	downloadMax    int64
	failure        *tjucli.CLIError
}

func (provider *fakeProvider) List(_ context.Context, path, cursor string) (tjucli.ListResult, tjucli.ListMeta, *tjucli.CLIError) {
	provider.listPath, provider.listCursor = path, cursor
	if provider.failure != nil {
		return tjucli.ListResult{}, tjucli.ListMeta{}, provider.failure
	}
	next := "next"
	return tjucli.ListResult{Items: []tjucli.Item{{Name: "x", Path: "/x", Kind: tjucli.KindFolder}}}, tjucli.ListMeta{NextCursor: &next}, nil
}

func (provider *fakeProvider) Search(_ context.Context, query string, maxPages, limit int) (tjucli.SearchResult, tjucli.SearchMeta, *tjucli.CLIError) {
	provider.searchQuery, provider.searchMaxPages, provider.searchLimit = query, maxPages, limit
	if provider.failure != nil {
		return tjucli.SearchResult{}, tjucli.SearchMeta{}, provider.failure
	}
	return tjucli.SearchResult{}, tjucli.SearchMeta{Scope: "course-catalog", PagesScanned: 1}, nil
}

func (provider *fakeProvider) Download(_ context.Context, path, output string, maxBytes int64) (tjucli.DownloadResult, *tjucli.CLIError) {
	provider.downloadPath, provider.downloadOutput, provider.downloadMax = path, output, maxBytes
	if provider.failure != nil {
		return tjucli.DownloadResult{}, provider.failure
	}
	return tjucli.DownloadResult{LocalPath: output, Bytes: 3, SHA256: strings.Repeat("a", 64)}, nil
}

func TestJSONFlagWorksAfterSubcommandAndPositionalArgument(t *testing.T) {
	t.Parallel()
	provider := &fakeProvider{}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	code := (&runner{provider: provider, stdout: stdout, stderr: stderr}).run(context.Background(), []string{"course", "ls", "/课程", "--cursor", "opaque", "--json"})
	if code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
	if provider.listPath != "/课程" || provider.listCursor != "opaque" {
		t.Fatalf("list call = (%q, %q)", provider.listPath, provider.listCursor)
	}
	var envelope struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
		Meta struct {
			NextCursor *string `json:"next_cursor"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.OK || envelope.Meta.NextCursor == nil || *envelope.Meta.NextCursor != "next" || len(envelope.Data) == 0 {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestSearchAndDownloadDefaults(t *testing.T) {
	t.Parallel()
	provider := &fakeProvider{}
	run := func(args ...string) int {
		return (&runner{provider: provider, stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}}).run(context.Background(), args)
	}
	if code := run("course", "search", "视觉"); code != 0 {
		t.Fatalf("search code = %d", code)
	}
	if provider.searchQuery != "视觉" || provider.searchMaxPages != tjucli.DefaultSearchPages || provider.searchLimit != tjucli.DefaultSearchLimit {
		t.Fatalf("search call = (%q, %d, %d)", provider.searchQuery, provider.searchMaxPages, provider.searchLimit)
	}
	if code := run("course", "download", "/课程/file", "--output", "local", "--json"); code != 0 {
		t.Fatalf("download code = %d", code)
	}
	if provider.downloadPath != "/课程/file" || provider.downloadOutput != "local" || provider.downloadMax != tjucli.DefaultDownloadBytes {
		t.Fatalf("download call = (%q, %q, %d)", provider.downloadPath, provider.downloadOutput, provider.downloadMax)
	}
}

func TestInvalidArgumentsReturnStableJSONErrorAndExitTwo(t *testing.T) {
	t.Parallel()
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	code := (&runner{provider: &fakeProvider{}, stdout: stdout, stderr: stderr}).run(context.Background(), []string{"course", "download", "/file", "--json"})
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	var envelope tjucli.FailureEnvelope
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.OK || envelope.Error.Code != "invalid_argument" || envelope.Error.Message == "" {
		t.Fatalf("envelope = %#v", envelope)
	}
	if stderr.Len() != 0 {
		t.Fatalf("JSON diagnostic written to stderr: %q", stderr.String())
	}
}

func TestRuntimeErrorsUseExitOneAndDoNotLeakSignedURL(t *testing.T) {
	t.Parallel()
	provider := &fakeProvider{failure: tjucli.NewRuntimeError("upstream_error", "course provider request failed")}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	code := (&runner{provider: provider, stdout: stdout, stderr: stderr}).run(context.Background(), []string{"course", "ls", "--json"})
	if code != 1 {
		t.Fatalf("code = %d", code)
	}
	if strings.Contains(stdout.String(), "http") || strings.Contains(stdout.String(), "token") {
		t.Fatalf("JSON leaked URL: %q", stdout.String())
	}
	var envelope tjucli.FailureEnvelope
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil || envelope.Error.Code != "upstream_error" {
		t.Fatalf("envelope=%#v err=%v", envelope, err)
	}
}

func TestHumanErrorUsesStderr(t *testing.T) {
	t.Parallel()
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	code := (&runner{provider: &fakeProvider{}, stdout: stdout, stderr: stderr}).run(context.Background(), []string{"unknown"})
	if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestVersionCapabilitiesAndHelp(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		args []string
		want string
	}{
		{args: []string{"--help"}, want: "public course-sharing"},
		{args: []string{"version", "--json"}, want: `"version":"dev"`},
		{args: []string{"capabilities", "--json"}, want: `"course download"`},
		{args: []string{"course", "--help"}, want: "max-bytes=67108864"},
	} {
		stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
		code := (&runner{provider: &fakeProvider{}, stdout: stdout, stderr: stderr}).run(context.Background(), test.args)
		if code != 0 || !strings.Contains(stdout.String(), test.want) {
			t.Errorf("args=%v code=%d stdout=%q stderr=%q", test.args, code, stdout.String(), stderr.String())
		}
	}
}
