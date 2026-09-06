# API

One Go module, currently a standard-library HTTP service with `GET /healthz`.
This proves the development and container build path, not business readiness.

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
migrations only when needed. Binaries go to ignored `bin/`. No authentication,
campus integration, database or agent execution is implemented yet.
