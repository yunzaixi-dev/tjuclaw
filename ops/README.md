# Operations

`images/` contains local API/Web image definitions; `runbooks/` contains reviewed
development and CI instructions. Root `compose.yaml` is a local smoke-test stack,
not a production deployment or the complete execution infrastructure.

```bash
rtk task compose:config
rtk task compose:context
rtk task compose:up
rtk task compose:ps
rtk task compose:smoke
rtk task compose:logs
rtk task compose:down
```

Web: `http://127.0.0.1:8088`; API health: `http://127.0.0.1:8080/healthz`.
The Web container proxies `/api/healthz` to the API health route.
Use shell environment variables `WEB_PORT` / `API_PORT` for port overrides.
Task explicitly selects the safe Compose example rather than loading root `.env`.

Containers are read-only, non-root, drop capabilities and have no host mounts.
Stopping them does not delete volumes. This initial stack has no persistent user
data or database. Rebuild from a known reviewed revision to roll back images.

Real configuration, credentials and runtime state stay in ignored `ops/local/`
or other private storage. Do not mount repository roots, Docker sockets or private
research into build containers. Do not operate existing clusters without approval.

`auth/` contains a separate local Kratos/PostgreSQL/Mailpit stack, identity policy,
Chinese email templates and production/Resend instructions. Unlike root Compose,
this stack has persistent development identities. See `auth/README.md`; real
SMTP credentials and existing-cluster changes are never applied automatically.
