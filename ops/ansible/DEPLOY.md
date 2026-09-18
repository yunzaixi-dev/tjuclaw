# Release deployment

`dev` is the default development branch. Pushes run CI. Merge or fast-forward the verified commit into `release` to publish; version tags and feature branches are optional.

The integration CI builds a Linux amd64 API artifact from its pinned backend SHA. After portable checks, real authentication tests and Ansible regressions pass, the reusable deployment workflow downloads that same run's artifact. It verifies the integration SHA, backend SHA and SHA256, rejects stale queued releases, and deploys serially through Ansible. The GitHub `production` environment must permit only the `release` branch.

## Production configuration

Environment secrets: `DEPLOY_SSH_KEY` (dedicated deployment key), `DEPLOY_KNOWN_HOSTS` (verified host keys). Environment variables: `DEPLOY_HOST`, `DEPLOY_USER`. Never upload a developer's personal private key. SSH host checking stays enabled. These credentials are not included in artifacts.

The host must already have systemd, Python 3 and a healthy Kratos public endpoint. A root-owned, mode-0600 `/etc/tjuclaw-api.env` must contain unique, unquoted assignments:

```dotenv
APP_PUBLIC_URL=https://app.example.invalid
KRATOS_PUBLIC_URL=http://127.0.0.1:4433
```

These are examples, not deployed endpoints. Complete identity configuration and HTTPS ingress before serving users. The playbook does not provision Kratos, SMTP, databases, TLS or EdgeOne routing. Missing configuration fails before service changes.

## Update and recovery

The dedicated `tjuclaw-api` systemd service runs as an unprivileged user. Versioned binaries live under `/opt/tjuclaw-api/releases/<integration-sha>/`; `current` selects a release. Data stays in `/var/lib/tjuclaw-api` (0700). The unit invokes `/usr/bin/env` with fixed loopback `HTTP_ADDR` and `TASK_DATA_DIR` assignments, so EnvironmentFile precedence cannot accidentally expose the API or change its storage directory.

An existing SHA cannot be overwritten with different bytes. Updating changes the symlink and restarts one service; it does not start overlapping API writers. A failed restart or HTTP `/healthz` check stops the failed process, restores the previous unit and symlink, restarts and checks the old service, then reports failure. A failed first deployment stops/disables the new unit and removes the active link. Release directories and user data are retained. No database downgrade or data restoration is implied.

The current JSON store requires a single API process, so updates have a short interruption. This is not a zero-downtime deployment. Xray, EasyConnect, frps, firewall rules and ingress configuration are outside this role's ownership.

For a deliberate manual deployment, prepare ignored `ops/local/deploy.yml` from `deploy.example.yml`, then run `task ops:api:deploy`. Editing the external environment file requires a separately managed service restart; same-release Ansible runs do not detect external environment edits.

## Verification limits

`task ops:check` validates syntax. `task ops:test` executes local Ansible regression scenarios with systemd operations simulated: missing/invalid config, checksum mismatch, immutable release collision, idempotence, failed update rollback and failed first-install cleanup. These tests do not prove production systemd behavior, real identity login or end-to-end EdgeOne connectivity. Perform those checks on the configured target before declaring production ready.

## Web, docs and slides

The client repository's release CI publishes its verified Web artifact using pinned `edgeone@1.6.37 makers deploy`. Configure its `production` environment with secret `EDGEONE_TOKEN`, variable `EDGEONE_PROJECT_NAME`, and optional `EDGEONE_AREA` according to the approved deployment configuration. Use an existing direct-upload project and validate SPA fallback and `/api` origin routing. Do not simultaneously enable a separate Git auto-deployment for the same production Web project, which would bypass the CI gate.

Docs use Next.js static export (`docs/out`) and Fumadocs static search. Run `task docs:build` before deploying that directory to the dedicated EdgeOne Makers project `tjuclaw-docs`. Dynamic server-side features require a new deployment design; this static deployment does not provide a Next.js server runtime.
