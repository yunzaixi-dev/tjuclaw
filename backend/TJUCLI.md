# tjucli

`tjucli` is a standard-library Go CLI for verified Tianjin University data providers. The first implemented provider is the public course-sharing catalog at `cs.tjuse.com`. It does not use campus credentials.

## Build

From the repository root:

```sh
rtk task cli:build
rtk task cli:test
rtk proxy backend/bin/tjucli capabilities --json
```

The binary is written to ignored `backend/bin/` and embeds the root package version.
For Pi usage, see `skills/tjucli/SKILL.md`; product runtime integration is still pending.

## Commands

```text
tjucli version [--json]
tjucli capabilities [--json]
tjucli course ls [PATH] [--cursor CURSOR] [--json]
tjucli course search QUERY [--max-pages N] [--limit N] [--json]
tjucli course download PATH --output FILE [--max-bytes N] [--json]
```

`course ls` returns one provider page. Its `next_cursor` is opaque and can be supplied unchanged with `--cursor`.

`course search` performs case-insensitive course-name matching over paginated items in the root catalog. It is not recursive and does not search file contents. The JSON metadata reports `scope`, `pages_scanned`, and `incomplete`. The default limits are 20 pages and 50 results; maximums are 100 pages and 1,000 results.

`course download` downloads one public file to an explicit local path. It refuses existing files and symbolic links. The default size limit is 64 MiB and the maximum accepted limit is 1 GiB. A successful result reports the absolute local path, byte count, and SHA-256 checksum.

All commands accept `--json`, including after a subcommand or positional argument. JSON output uses these envelopes:

```json
{"ok":true,"data":{},"meta":{}}
{"ok":false,"error":{"code":"invalid_argument","message":"..."}}
```

Invalid command arguments exit with status 2. Provider, protocol, download, and filesystem failures exit with status 1. Human-readable diagnostics are written to standard error.

## Safety boundaries

Provider paths are normalized to a leading slash and reject traversal segments, backslashes, control characters, and invalid UTF-8. Catalog response sizes and request duration are bounded.

Downloads allow at most five redirects. Redirects must use HTTPS and must remain on the course host or fixed OneDrive/Microsoft download domains. Signed redirect URLs and upstream response bodies are never included in CLI errors. Downloads reject HTML responses, stream through a bounded sibling temporary file, confirm declared length when available, and publish without replacing an existing target. Partial files are removed after failure.

## Coverage gaps

The following intended categories are not implemented and are not advertised by `tjucli capabilities`:

- Campus identity, student login, and personal account data
- Timetables, grades, examinations, and academic records
- Campus card, payments, library accounts, and facility access
- Notices, messaging, community, and organization services
- Other course platforms or private course resources

No guessed WePeiYang tokens, competitor code, or unverified campus commands are included.
