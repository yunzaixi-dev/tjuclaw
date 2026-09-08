# API

One Go module with a standard-library HTTP server, `GET /healthz`, a browser-only
Kratos flow gateway, `GET /auth/session`, and authenticated task routes under `/tasks`.
See root `DEVELOPMENT.md` for API standards and `ops/auth/README.md` for identity
configuration and real local tests.

From the repository root:

```bash
rtk task api:dev
rtk task api:test
rtk task api:lint
rtk task api:build
```

Defaults to `127.0.0.1:8080`. The container explicitly sets `HTTP_ADDR=0.0.0.0:8080`
and Compose publishes only to host loopback. Unknown routes return 404;
unsupported health methods return 405.

Executable entry: `cmd/api/`. Business packages live under `internal/`:
- `internal/auth`: validates live Kratos sessions, forwards allowlisted browser flows,
  preserves cookies/CSRF, and enforces same-origin browser policies. Missing Kratos
  configuration returns 503 `auth_not_configured`.
- `internal/task`: provides isolated file-based task storage and REST handlers
  (`GET /tasks`, `POST /tasks`, `GET /tasks/{id}`). Tasks have status `draft`.
  Tasks are stored in directory `TASK_DATA_DIR` (default `data/` relative to working
  directory). A single API process owns this directory (not designed for multi-replica
  concurrent file access). Storage enforces strict directory tree boundaries via `os.Root`,
  atomic durable file writes, fail-closed corruption handling, a limit of 1000 tasks
  per owner, and SHA-256 hashed owner directories.

Missing or invalid session returns 401 `session_required`. If auth is unconfigured,
task routes return 503 `auth_not_configured`. Model execution and campus services
are not connected yet.
