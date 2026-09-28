# Release deployment

`dev` is the default development branch. Pushes run CI. Merge or fast-forward the verified commit into `release` to publish; version tags and feature branches are optional.

The integration CI builds a Linux amd64 API artifact from its pinned backend SHA. Pushes do not deploy: the self-hosted runner's link to the API host is too slow for routine releases, so production deploys run locally with `task ops:api:deploy`, or by running CI manually on `release` with `deploy_api` checked. In that case, after portable checks, real authentication tests and Ansible regressions pass, the reusable deployment workflow downloads that same run's artifact. It verifies the integration SHA, backend SHA and SHA256, rejects stale queued releases, and deploys serially through Ansible. The artifact travels gzip compressed; when the running binary already matches it (an unchanged backend), the host copies it locally instead. The GitHub `production` environment must permit only the `release` branch.

## Production configuration

Environment secrets: `DEPLOY_SSH_KEY` (dedicated deployment key), `DEPLOY_KNOWN_HOSTS` (verified host keys). Environment variables: `DEPLOY_HOST`, `DEPLOY_USER`. Never upload a developer's personal private key. SSH host checking stays enabled. These credentials are not included in artifacts.

The host must already have systemd, Python 3 and a healthy Kratos public endpoint. A root-owned, mode-0600 `/etc/tjuclaw-api.env` must contain unique, unquoted assignments:

```dotenv
APP_PUBLIC_URL=https://app.example.invalid
KRATOS_PUBLIC_URL=http://127.0.0.1:4433
```

These are examples, not deployed endpoints. Complete identity configuration and HTTPS ingress before serving users. The playbook does not provision Kratos, SMTP, databases, TLS or EdgeOne routing. Missing configuration fails before service changes.

To route authenticated agent sessions through the Kubernetes Sandbox Gateway,
add the following to the same root-only environment file after provisioning a
verified HTTPS origin reachable **from the API host**:

```dotenv
SANDBOX_SESSION_URL=https://sandbox.example.invalid
SANDBOX_GATEWAY_HMAC_SECRET=<shared-random-secret-at-least-32-bytes>
```

Use the exact HMAC value held by the Gateway control plane, not its
`sandbox-session-token`, Forgejo token or model key. The Gateway Service is
ClusterIP-only and cannot be addressed by this external systemd service.
`SANDBOX_GATEWAY_PUBLIC_URL` is optional and must only be set after separately
securing and testing the browser-facing EdgeOne route. Do not route the Broker
port or the controller publicly. The preflight rejects missing credentials
and non-HTTPS origins. For sandbox mode, it checks the Gateway's `/readyz`,
session and vault routes from the API host over verified TLS before modifying
the service. A missing vault route or untrusted certificate blocks deployment.
If using a private CA, set the Ansible variable `api_sandbox_preflight_ca_path`
to its trusted CA file on the target host; certificate verification stays on.
If `SANDBOX_GATEWAY_PUBLIC_URL` is set, preflight also checks the EdgeOne-facing
readiness, session, quota and vault routes from the API host. This does not
prove access from every browser network or an authenticated session. Sandbox
mode no longer needs `NEWAPI_API_KEY` on the API host, but the Gateway Broker
must have a working provider key and quota store.

The public preflight also sends browser-style OPTIONS requests for every Git
note/search/graph method. It requires the exact `APP_PUBLIC_URL` origin and
authorization/content-type CORS headers, verifies an unauthenticated note
request reaches the Gateway, and rejects an unrelated origin. These checks
do not replace a real browser test with an owner-bound token or Forgejo write.

Sandbox-enabled deployments also require `api_sandbox_kube_context` in the
Ansible variables. The controller (including CI runners) must have `kubectl`,
a kubeconfig for that explicit context and read-only `get/list` permission on
`sandboxes.agents.x-k8s.io` in `tjuclaw-sandbox-runtime`. Before changing the
API, preflight refuses a failed cluster query or any Sandbox without a valid
session-binding annotation. Do not work around this by patching old objects.
This check only catches obvious legacy objects: even a bound object may fail
the Gateway's full owner, image and runtime verification, and it does not
establish that ephemeral Pi history was checkpointed or that Git encryption
is approved. Follow `sandbox/k8s/gateway/README.md` for export, recovery and
controlled cutover; never delete a live old Pod merely to pass preflight.

## Update and recovery

The dedicated `tjuclaw-api` systemd service runs as an unprivileged user. Versioned binaries live under `/opt/tjuclaw-api/releases/<integration-sha>/`; `current` selects a release. Data stays in `/var/lib/tjuclaw-api` (0700). The unit invokes `/usr/bin/env` with fixed loopback `HTTP_ADDR` and `TASK_DATA_DIR` assignments, so EnvironmentFile precedence cannot accidentally expose the API or change its storage directory.

An existing SHA cannot be overwritten with different bytes. Updating changes the symlink and restarts one service; it does not start overlapping API writers. A failed restart or HTTP `/healthz` check stops the failed process, restores the previous unit and symlink, restarts and checks the old service, then reports failure. A failed first deployment stops/disables the new unit and removes the active link. Release directories and user data are retained. No database downgrade or data restoration is implied.

The file-backed task/run/library store requires a single API process. Setting `DATABASE_URL` switches **task, run, library and Anki** storage to PostgreSQL at once. On an existing file-backed installation, stop all API writers and back up the entire `/var/lib/tjuclaw-api` tree before cutover. An independently verified list of Kratos identity IDs is required to map the hashed task and knowledge-library directories to owners; the JSON records alone cannot recover their owners. Put only those IDs in a mode-0600 JSON array outside the data tree and run `go run ./cmd/legacy-inventory -data-dir /secure/backup -owners /secure/identity-ids.json` from `backend/`. This read-only check rejects unmapped directories, symlinks, invalid records and broken ownership/references, and prints record counts plus a SHA-256 snapshot fingerprint. Keep its output and re-run it on the frozen backup before and after import to detect a changed source. Do not put identity IDs, JSON bodies or secrets in public logs. Anki state files larger than 128 MiB require a separate reviewed migration procedure.

With the API stopped and the same validated backup, set `DATABASE_URL` in the process environment and run these three commands from `backend/` against the **product database only**, after backing up that database:

```bash
go run ./cmd/legacy-task-run-migrate -data-dir /secure/backup -owners /secure/identity-ids.json
go run ./cmd/legacy-library-migrate -data-dir /secure/backup -owners /secure/identity-ids.json
go run ./cmd/anki-migrate -data-dir /secure/backup
go run ./cmd/legacy-verify-target -data-dir /secure/backup -owners /secure/identity-ids.json
```

Task/run and library each import in one transaction, reject changed existing rows and extra target rows for the mapped owners, and recheck the source snapshot before committing. Knowledge migration includes private notes, sessions, published snapshots, subscriptions, model settings, quota and referenced blob bytes; an unowned blob aborts instead of being dropped. Legacy blobs have no creation timestamp, so the database receives the deterministic Unix epoch for those rows. Anki is a separate transaction and imports only its state files. These commands are **not** one atomic cross-domain migration; restore the target database backup on a partial failure. The last command opens one read-only, repeatable-read database snapshot, checks every migrated row and blob byte against the frozen source plus per-owner counts, then rechecks the source fingerprint. It neither initializes tables nor writes the cutover marker. Retain its output, repeat it after restoring a database backup, and independently inspect owner identity coverage and production recovery before attesting the cutover; this command is not an automatic go-live approval. Do not run file-mode and PostgreSQL-mode APIs concurrently.

The preflight refuses a PostgreSQL cutover while file-backed JSON records remain unless a root-owned, mode-0600 `/var/lib/tjuclaw-api/.postgres-migration-verified` marker is present. Create that marker **only after** the independent database verification; it is an operator attestation, not an automatic migration. The systemd rollout still has a short interruption and is not zero-downtime. Xray, EasyConnect, frps, firewall rules and ingress configuration are outside this role's ownership.

For a deliberate manual deployment, prepare ignored `ops/local/deploy.yml` from `deploy.example.yml`, then run `task ops:api:deploy`. Editing the external environment file requires a separately managed service restart; same-release Ansible runs do not detect external environment edits.

## Verification limits

`task ops:check` validates syntax. `task ops:test` executes local Ansible regression scenarios with systemd operations simulated: missing/invalid config, checksum mismatch, immutable release collision, idempotence, failed update rollback and failed first-install cleanup. These tests do not prove production systemd behavior, real identity login or end-to-end EdgeOne connectivity. Perform those checks on the configured target before declaring production ready.

## Web, docs and slides

The client repository's release CI publishes its verified Web artifact using pinned `edgeone@1.6.37 makers deploy`. Configure its `production` environment with secret `EDGEONE_TOKEN`, variable `EDGEONE_PROJECT_NAME`, and optional `EDGEONE_AREA` according to the approved deployment configuration. When enabling browser-direct Git notes, set `EDGEONE_SANDBOX_ORIGIN` to the exact HTTPS origin returned by the API's `SANDBOX_GATEWAY_PUBLIC_URL` (no path or trailing slash); the generated CSP permits only that origin in addition to `self`. Without this variable, sandbox-direct browser requests remain blocked by CSP. The generated EdgeOne configuration falls back to `index.html` only after function and static-file routing; `/api/*` must still reach the API function, never SPA HTML. Use an existing direct-upload project. After deployment CI polls the product browser origin (default `https://app.tjuclaw.cloud`, override with `EDGEONE_PUBLIC_ORIGIN`) for `/auth/login`, `/workspace`, the exact CSP, `/api/healthz` JSON 200 and anonymous `/api/auth/session` JSON 401; it requires three consecutive fully healthy checks to avoid approving intermittent API failures. The homepage `https://tjuclaw.cloud` is not the product app and must not be used for this smoke check. A failed check leaves the job red; it does not roll back the CDN deployment. These checks do not prove authenticated traffic or access from every browser network. Do not simultaneously enable a separate Git auto-deployment for the same production Web project, which would bypass the CI gate.

Docs use Next.js static export (`docs/out`) and Fumadocs static search. Run `task docs:build` before deploying that directory to the dedicated EdgeOne Makers project `tjuclaw-docs`. Dynamic server-side features require a new deployment design; this static deployment does not provide a Next.js server runtime.
