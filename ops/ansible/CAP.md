# Cap standalone

`task ops:cap:deploy` manages an independent [Cap](https://github.com/tiagozip/cap)
3.1.11 service and Valkey 9.1.2. Both official images are pinned by digest in
`roles/cap_stack/defaults/main.yml` and `cap.example.yml`; the current image
selection was verified on amd64. This service is separate from Kratos and NewAPI.

## Deploy

1. Select the intended host in ignored `ops/local/ansible-inventory.yml`.
2. Copy `ops/ansible/cap.example.yml` to ignored `ops/local/cap.yml`.
3. Run `task ops:check` and `node --test ops/ansible/tests/cap.test.mjs`.
4. Load the verified images on the target or allow Docker to pull their exact digests.
5. Run `task ops:cap:deploy`.

The role refuses unmanaged directories, conflicting container/network/volume names,
unrelated listeners, and missing or damaged secrets on an existing deployment.
It never takes over the identity stack. A first deployment generates a random
administrator key on the target; subsequent deployments preserve the environment
file byte for byte. Ansible suppresses secret task output.

## Access and storage

- Compose project: `tjuclaw-cap`, configuration: `/opt/tjuclaw-cap` (root `0700`).
- Cap dashboard/API: `127.0.0.1:3300`; no public administration port.
- Administrator key: `ADMIN_KEY` in `/opt/tjuclaw-cap/.env.cap` (root `0600`).
- Valkey: no host port, dedicated internal network and volume
  `tjuclaw-cap-valkey-data`; AOF enabled and eviction disabled.
- Cap additionally joins an access bridge so Docker can publish its loopback port.
  Valkey remains on the internal network only.
- Cap runs as UID 1000 with a read-only root filesystem and temporary `/tmp`;
  Valkey runs as UID 999. Both drop capabilities and prevent privilege escalation.
- Each container has a 128 MiB memory limit. Valkey's dataset limit is 64 MiB,
  leaving headroom for persistence. Monitor utilization before increasing traffic.

For a host configured with the local SSH alias `tjuclaw-core`:

```sh
ssh -N -L 13300:127.0.0.1:3300 tjuclaw-core
```

Open `http://127.0.0.1:13300` locally and use the administrator key from the
server's private environment file. Retrieve secrets only in a trusted terminal;
never place them in Git, public docs, browser assets or logs.

The initial deployment may additionally provision a site named `TJUClaw` through
the authenticated management API. Its one-time returned secret must be saved
securely; the deployment bootstrap stores it at `/opt/tjuclaw-cap/site-key.json`
(root `0600`). The Ansible role itself does not create or rotate site keys.

For the default deployment paths, the checked-in helpers can initialize the site
and exercise the full verification chain without printing credentials:

```sh
ssh tjuclaw-core python3 - < ops/ansible/roles/cap_stack/files/bootstrap.py
ssh tjuclaw-core python3 - < ops/ansible/roles/cap_stack/files/smoke.py
```

The bootstrap preserves an existing site-key file and refuses to create a second
TJUClaw site if the original secret is missing. The smoke helper bounds PoW work,
uses the stored site secret for `siteverify`, and checks single-use enforcement.

## Verification and recovery

Readiness checks require an unauthenticated `GET /public/logo-small.webp` to return
200 and `GET /server/keys` to reject anonymous access with 401. These routes were
verified in the upstream standalone implementation. Valkey also has its own PING
health check. Static asset caching through `/assets/` is disabled; a future client
integration should bundle widget/WASM assets locally.

An invalid Compose candidate or failed readiness check restores the previous
Compose file, restarts its services and checks readiness again. On an initial
failure, the candidate stack is stopped without deleting its volume or secrets.
This is a configuration rollback, not a database-format rollback: make an offline
backup before upgrading Valkey or introducing incompatible Cap data changes.

For a consistent backup, stop this Compose project, back up the named volume and
private configuration directory to restricted storage, then start it again. Keep
administrator and site secrets with the matching Valkey backup. Do not use
`docker compose down --volumes`. There is no off-host backup schedule installed by
this role.

A useful service smoke check exercises an owned site key through challenge,
redemption and server verification, then checks that a second verification of the
same token is rejected. Recheck key availability and unchanged credentials after
restarting the containers and rerunning the deployment task.

## Product integration boundary

Self-hosting this service does not enforce CAPTCHA on product authentication.
A future integration must expose only challenge/redeem endpoints under
`https://app.tjuclaw.cloud/api/*`, bundle the browser widget and WASM assets, and
require server-side `siteverify` before forwarding protected actions to Kratos.
The site secret remains on the server. Cap administration stays private, and
Kratos remains the only identity authority. A frontend-only widget can be bypassed
and must not be presented as login protection.
