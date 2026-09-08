package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw/backend/internal/tjucli"
)

var (
	version = "dev"
	commit  = ""
)

type courseProvider interface {
	List(context.Context, string, string) (tjucli.ListResult, tjucli.ListMeta, *tjucli.CLIError)
	Search(context.Context, string, int, int) (tjucli.SearchResult, tjucli.SearchMeta, *tjucli.CLIError)
	Download(context.Context, string, string, int64) (tjucli.DownloadResult, *tjucli.CLIError)
}

type runner struct {
	provider courseProvider
	stdout   io.Writer
	stderr   io.Writer
}

func main() {
	provider, err := tjucli.NewProvider()
	if err != nil {
		fmt.Fprintln(os.Stderr, "tjucli: provider initialization failed")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := (&runner{provider: provider, stdout: os.Stdout, stderr: os.Stderr}).run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}

func (r *runner) run(ctx context.Context, args []string) int {
	args, jsonOutput, jsonErr := extractJSON(args)
	if jsonErr != nil {
		return r.fail(jsonOutput, jsonErr)
	}
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprint(r.stdout, rootHelp)
		return 0
	}

	switch args[0] {
	case "version":
		return r.runVersion(args[1:], jsonOutput)
	case "capabilities":
		return r.runCapabilities(args[1:], jsonOutput)
	case "course":
		return r.runCourse(ctx, args[1:], jsonOutput)
	default:
		return r.fail(jsonOutput, tjucli.NewFlagError(fmt.Sprintf("unknown command %q", args[0])))
	}
}

func (r *runner) runVersion(args []string, jsonOutput bool) int {
	if helpRequested(args) {
		fmt.Fprintln(r.stdout, "Usage: tjucli version [--json]")
		return 0
	}
	if len(args) != 0 {
		return r.fail(jsonOutput, tjucli.NewFlagError("version does not accept positional arguments"))
	}
	data := tjucli.VersionResult{Version: version, Commit: commit}
	if jsonOutput {
		return r.success(data, struct{}{})
	}
	fmt.Fprintln(r.stdout, version)
	return 0
}

func (r *runner) runCapabilities(args []string, jsonOutput bool) int {
	if helpRequested(args) {
		fmt.Fprintln(r.stdout, "Usage: tjucli capabilities [--json]")
		return 0
	}
	if len(args) != 0 {
		return r.fail(jsonOutput, tjucli.NewFlagError("capabilities does not accept positional arguments"))
	}
	data := tjucli.CapabilitiesResult{
		Provider: "public-course-sharing",
		Commands: []string{"course ls", "course search", "course download"},
	}
	if jsonOutput {
		return r.success(data, struct{}{})
	}
	fmt.Fprintln(r.stdout, "public-course-sharing")
	for _, command := range data.Commands {
		fmt.Fprintf(r.stdout, "  %s\n", command)
	}
	return 0
}

func (r *runner) runCourse(ctx context.Context, args []string, jsonOutput bool) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprint(r.stdout, courseHelp)
		return 0
	}
	switch args[0] {
	case "ls":
		return r.runList(ctx, args[1:], jsonOutput)
	case "search":
		return r.runSearch(ctx, args[1:], jsonOutput)
	case "download":
		return r.runDownload(ctx, args[1:], jsonOutput)
	default:
		return r.fail(jsonOutput, tjucli.NewFlagError(fmt.Sprintf("unknown course command %q", args[0])))
	}
}

func (r *runner) runList(ctx context.Context, args []string, jsonOutput bool) int {
	if helpRequested(args) {
		fmt.Fprintln(r.stdout, "Usage: tjucli course ls [PATH] [--cursor CURSOR] [--json]")
		return 0
	}
	positional, options, parseErr := parseOptions(args, map[string]bool{"cursor": true})
	if parseErr != nil {
		return r.fail(jsonOutput, parseErr)
	}
	if len(positional) > 1 {
		return r.fail(jsonOutput, tjucli.NewFlagError("course ls accepts at most one path"))
	}
	providerPath := "/"
	if len(positional) == 1 {
		providerPath = positional[0]
	}
	data, meta, listErr := r.provider.List(ctx, providerPath, options["cursor"])
	if listErr != nil {
		return r.fail(jsonOutput, listErr)
	}
	if jsonOutput {
		return r.success(data, meta)
	}
	for _, item := range data.Items {
		fmt.Fprintf(r.stdout, "%s\t%d\t%s\n", item.Kind, item.Size, item.Path)
	}
	if meta.NextCursor != nil {
		fmt.Fprintf(r.stdout, "next cursor: %s\n", *meta.NextCursor)
	}
	return 0
}

func (r *runner) runSearch(ctx context.Context, args []string, jsonOutput bool) int {
	if helpRequested(args) {
		fmt.Fprintln(r.stdout, "Usage: tjucli course search QUERY [--max-pages N] [--limit N] [--json]")
		return 0
	}
	positional, options, parseErr := parseOptions(args, map[string]bool{"max-pages": true, "limit": true})
	if parseErr != nil {
		return r.fail(jsonOutput, parseErr)
	}
	if len(positional) != 1 {
		return r.fail(jsonOutput, tjucli.NewFlagError("course search requires exactly one query"))
	}
	maxPages, numberErr := integerOption(options, "max-pages", tjucli.DefaultSearchPages)
	if numberErr != nil {
		return r.fail(jsonOutput, numberErr)
	}
	limit, numberErr := integerOption(options, "limit", tjucli.DefaultSearchLimit)
	if numberErr != nil {
		return r.fail(jsonOutput, numberErr)
	}
	data, meta, searchErr := r.provider.Search(ctx, positional[0], maxPages, limit)
	if searchErr != nil {
		return r.fail(jsonOutput, searchErr)
	}
	if jsonOutput {
		return r.success(data, meta)
	}
	for _, item := range data.Items {
		fmt.Fprintf(r.stdout, "%s\t%s\n", item.Kind, item.Path)
	}
	fmt.Fprintf(r.stderr, "scanned %d page(s); incomplete=%t\n", meta.PagesScanned, meta.Incomplete)
	return 0
}

func (r *runner) runDownload(ctx context.Context, args []string, jsonOutput bool) int {
	if helpRequested(args) {
		fmt.Fprintln(r.stdout, "Usage: tjucli course download PATH --output FILE [--max-bytes N] [--json]")
		return 0
	}
	positional, options, parseErr := parseOptions(args, map[string]bool{"output": true, "max-bytes": true})
	if parseErr != nil {
		return r.fail(jsonOutput, parseErr)
	}
	if len(positional) != 1 {
		return r.fail(jsonOutput, tjucli.NewFlagError("course download requires exactly one provider path"))
	}
	if options["output"] == "" {
		return r.fail(jsonOutput, tjucli.NewFlagError("course download requires --output FILE"))
	}
	maxBytes, numberErr := int64Option(options, "max-bytes", tjucli.DefaultDownloadBytes)
	if numberErr != nil {
		return r.fail(jsonOutput, numberErr)
	}
	data, downloadErr := r.provider.Download(ctx, positional[0], options["output"], maxBytes)
	if downloadErr != nil {
		return r.fail(jsonOutput, downloadErr)
	}
	if jsonOutput {
		return r.success(data, struct{}{})
	}
	fmt.Fprintf(r.stdout, "%s\n%d bytes\nsha256 %s\n", data.LocalPath, data.Bytes, data.SHA256)
	return 0
}

func (r *runner) success(data, meta any) int {
	encoder := json.NewEncoder(r.stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(tjucli.SuccessEnvelope{OK: true, Data: data, Meta: meta}); err != nil {
		fmt.Fprintln(r.stderr, "tjucli: could not write JSON output")
		return 1
	}
	return 0
}

func (r *runner) fail(jsonOutput bool, cliErr *tjucli.CLIError) int {
	if jsonOutput {
		encoder := json.NewEncoder(r.stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(tjucli.FailureEnvelope{OK: false, Error: tjucli.CLIErrorPayload{Code: cliErr.Code, Message: cliErr.Message}}); err != nil {
			fmt.Fprintln(r.stderr, "tjucli: could not write JSON output")
			return 1
		}
	} else {
		fmt.Fprintf(r.stderr, "tjucli: %s\n", cliErr.Message)
	}
	return cliErr.ExitCode
}

func extractJSON(args []string) ([]string, bool, *tjucli.CLIError) {
	filtered := make([]string, 0, len(args))
	found := false
	for _, argument := range args {
		if argument == "--json" {
			if found {
				return nil, true, tjucli.NewFlagError("--json may only be specified once")
			}
			found = true
			continue
		}
		filtered = append(filtered, argument)
	}
	return filtered, found, nil
}

func parseOptions(args []string, accepted map[string]bool) ([]string, map[string]string, *tjucli.CLIError) {
	positional := make([]string, 0, len(args))
	options := make(map[string]string)
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if !strings.HasPrefix(argument, "--") {
			positional = append(positional, argument)
			continue
		}
		nameValue := strings.TrimPrefix(argument, "--")
		name, value, hasEquals := strings.Cut(nameValue, "=")
		needsValue, acceptedFlag := accepted[name]
		if !acceptedFlag || !needsValue {
			return nil, nil, tjucli.NewFlagError(fmt.Sprintf("unknown flag --%s", name))
		}
		if _, duplicate := options[name]; duplicate {
			return nil, nil, tjucli.NewFlagError(fmt.Sprintf("--%s may only be specified once", name))
		}
		if !hasEquals {
			index++
			if index >= len(args) {
				return nil, nil, tjucli.NewFlagError(fmt.Sprintf("--%s requires a value", name))
			}
			value = args[index]
		}
		if value == "" {
			return nil, nil, tjucli.NewFlagError(fmt.Sprintf("--%s requires a non-empty value", name))
		}
		options[name] = value
	}
	return positional, options, nil
}

func integerOption(options map[string]string, name string, fallback int) (int, *tjucli.CLIError) {
	value, exists := options[name]
	if !exists {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, tjucli.NewFlagError(fmt.Sprintf("--%s must be an integer", name))
	}
	return parsed, nil
}

func int64Option(options map[string]string, name string, fallback int64) (int64, *tjucli.CLIError) {
	value, exists := options[name]
	if !exists {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, tjucli.NewFlagError(fmt.Sprintf("--%s must be an integer", name))
	}
	return parsed, nil
}

func helpRequested(args []string) bool {
	return len(args) == 1 && (args[0] == "--help" || args[0] == "-h")
}

const rootHelp = `tjucli provides verified public Tianjin University data tools.

Implemented scope: public course-sharing catalog and file downloads.
No campus login or student credentials are used.

Usage:
  tjucli version [--json]
  tjucli capabilities [--json]
  tjucli course <command> [arguments] [--json]
  tjucli help

Run "tjucli course --help" for course commands.
`

const courseHelp = `Usage: tjucli course <command> [arguments] [--json]

Commands:
  ls [PATH] [--cursor CURSOR]             List one catalog page
  search QUERY [--max-pages N] [--limit N]
                                           Match root course names
  download PATH --output FILE [--max-bytes N]
                                           Download one public file

Defaults: PATH=/, max-pages=20, limit=50, max-bytes=67108864.
`
