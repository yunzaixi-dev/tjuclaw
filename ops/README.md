# Operations

## Ansible adoption

`ansible/` provides read-only host discovery, local HTTPS-origin candidate
rendering and isolated API deployment with rollback ([deployment contract](ansible/DEPLOY.md)). EdgeOne hosts frontend static assets, docs,
and slides; the Tencent Cloud host runs backend services only, with no Nginx,
static web container, or app gateway on the host.

The candidate HAProxy origin setup on the host accepts only same-origin `/api`
and `/api/*` requests, denies all other paths, strips `/api` exactly once, sets
HTTPS forwarded headers (`X-Forwarded-Proto https`, `X-Forwarded-Port 443`),
retains the original public Host, and forwards directly to the Go API backend
(sample loopback port `18080`, an example API loopback binding rather than a live fact).

EdgeOne must preserve the `/api` prefix and the original public Host/SNI, never
cache API or authentication responses, and never expose Kratos admin or internal
toolserver endpoints. EdgeOne-specific path routing and custom origin port
support remain to be verified. Tracked files never contain real hostnames, IPs,
or SSH aliases, and make no deployment claims. Existing proxies and campus VPN
containers are outside the playbook's ownership, with live reload strictly avoided.

Start with `task ops:check`; configure an ignored local inventory before
`task ops:discover`. `task ops:origin:render` produces a review candidate only
and never replaces live HAProxy configuration. See [the adoption guide](ansible/README.md).

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


`weknora/` is the isolated knowledge engine (loopback UI 18180, app 18181). It is
not identity and not a public origin. Local: `task weknora:up`. Cloud:
`task ops:weknora:deploy` with ignored `ops/local/weknora.yml` on a host with
spare RAM — not the 2 GiB core box. See `weknora/README.md`.

`auth/` contains the local ZITADEL/PostgreSQL/Mailpit stack, identity policy,
Chinese email templates and production SMTP instructions. Unlike root Compose,
this stack has persistent development identities. Development uses the configured
real SMTP environment by default; Mailpit is explicit for captured/offline runs.
See `auth/README.md`; real SMTP credentials and existing-cluster changes are never
applied automatically.
