package tjucli

import "fmt"

const (
	DefaultBaseURL       = "https://cs.tjuse.com"
	DefaultSearchPages   = 20
	MaximumSearchPages   = 100
	DefaultSearchLimit   = 50
	MaximumSearchLimit   = 1000
	DefaultDownloadBytes = int64(64 << 20)
	MaximumDownloadBytes = int64(1 << 30)
)

// ItemKind indicates whether a catalog item is a file or folder.
type ItemKind string

const (
	KindFile   ItemKind = "file"
	KindFolder ItemKind = "folder"
)

type Item struct {
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	Kind       ItemKind `json:"kind"`
	Size       int64    `json:"size"`
	ModifiedAt string   `json:"modified_at"`
}

type SuccessEnvelope struct {
	OK   bool `json:"ok"`
	Data any  `json:"data"`
	Meta any  `json:"meta"`
}

type FailureEnvelope struct {
	OK    bool            `json:"ok"`
	Error CLIErrorPayload `json:"error"`
}

type CLIErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type CLIError struct {
	Code     string
	Message  string
	ExitCode int
}

func (e *CLIError) Error() string {
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func NewFlagError(message string) *CLIError {
	return &CLIError{Code: "invalid_argument", Message: message, ExitCode: 2}
}

func NewRuntimeError(code, message string) *CLIError {
	return &CLIError{Code: code, Message: message, ExitCode: 1}
}

type ListResult struct {
	Items []Item `json:"items"`
}

type ListMeta struct {
	NextCursor *string `json:"next_cursor"`
}

type SearchResult struct {
	Items []Item `json:"items"`
}

type SearchMeta struct {
	Scope        string `json:"scope"`
	PagesScanned int    `json:"pages_scanned"`
	Incomplete   bool   `json:"incomplete"`
}

type DownloadResult struct {
	LocalPath string `json:"local_path"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
}

type VersionResult struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
}

type CapabilitiesResult struct {
	Provider string   `json:"provider"`
	Commands []string `json:"commands"`
}
