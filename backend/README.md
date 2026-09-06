# API

One Go module with a standard-library HTTP server, `GET /healthz`, a browser-only
Kratos flow gateway and `GET /auth/session`. See root `DEVELOPMENT.md` for API
standards and `ops/auth/README.md` for identity configuration and real local tests.

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

Executable entry: `cmd/api/`. Add business packages under `internal/` and database
migrations only when needed. Binaries go to ignored `bin/`.
`internal/auth` validates live Kratos sessions, forwards only selected browser
flows, preserves cookies/CSRF and rejects native/admin/password requests.
The API never creates an independent user database or issues session tokens.
Missing Kratos configuration returns 503. Campus services and agent execution
are not implemented yet.
