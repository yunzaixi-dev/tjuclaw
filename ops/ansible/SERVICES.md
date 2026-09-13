# Single-host service provisioning

Use the ignored `ops/local/ansible-inventory.yml` to select the confirmed host.
Run `task ops:check` before deployment. These roles manage separate Compose
projects; they do not take over existing containers or shared identity services.

```sh
task ops:services:prepare
task ops:newapi:deploy
task ops:zitadel:deploy
```

For the independent Cap CAPTCHA service, use `task ops:cap:deploy` with ignored
`ops/local/cap.yml`. Its dashboard listens on loopback port 3300 and is accessed
through an SSH tunnel; Valkey has no published port. See [CAP.md](CAP.md) for
persistent secrets, backup, rollback and the separate product integration boundary.

`ops:services:prepare` installs the Compose plugin and creates
`/etc/tjuclaw-api.env` only when absent. Review existing configuration separately;
rerunning preparation does not overwrite it.

## Identity

Before deployment, provision `/etc/tjuclaw-identity-smtp.env` on the target,
owned by root with mode `0600`, containing real production settings:

```dotenv
COURIER_SMTP_CONNECTION_URI=smtps://USER:URL_ENCODED_PASSWORD@SMTP_HOST:465/
COURIER_SMTP_FROM_ADDRESS=YOUR_VERIFIED_SENDER
```

The values above are placeholders. Percent-encode credentials in the URI.
Missing SMTP configuration stops deployment before services start. TLS
verification and STARTTLS must not be disabled. Do not commit this file or
include credentials in command arguments, logs, or issue descriptions.

The selected replacement is ZITADEL v4.17.3. Copy `zitadel.example.yml` to ignored
`ops/local/zitadel.yml`, then use `task ops:zitadel:deploy`. This creates isolated
PostgreSQL and ZITADEL under `/opt/tjuclaw-zitadel`, with a loopback 8085 listener,
durable database/master secrets and private machine bootstrap tokens. The API and
client must be delivered together to switch providers; this role leaves their
current selection intact. See [the authentication guide](../auth/ZITADEL.md).

### Legacy Kratos rollback

Kratos and its database use `/opt/tjuclaw-identity`, with durable secrets in
`.env.db` and `.env.kratos`. Back up these files together with the database.
Incomplete existing secret files stop deployment; restore them rather than
regenerating credentials for an existing database.

The browser uses the product's same-origin `/api/kratos/` proxy. Kratos public
and admin listeners stay on loopback. A separate authentication domain does
not justify changing this cookie and redirect contract.

## Internal model gateway

NewAPI and its database use `/opt/tjuclaw-newapi`. Initial administrator
credentials are generated on the target and stored in `credentials.json`
with mode `0600`. Keep this file, `.env.db`, and `.env.newapi` with protected
backups. Existing credentials are retained; damaged or partial secret files
stop deployment.

The gateway listens on `127.0.0.1:3000`; its database has no host-published port.
Use an SSH tunnel for administration:

```sh
ssh -N -L 3000:127.0.0.1:3000 YOUR_CONFIGURED_SSH_HOST
```

Open `http://127.0.0.1:3000` locally. Deployment initializes the administrator
and disables public registration. NewAPI is an operational model gateway;
ZITADEL is the selected replacement product identity authority. Configure model providers and
runtime credentials separately before claiming working model inference.

The default memory ceilings are 384 MiB for NewAPI and 256 MiB for its database;
Kratos and its database use 256 MiB and 384 MiB respectively. These are ceilings,
not capacity guarantees. Verify actual host memory after deployment.

When upstream model providers or endpoints require campus network routing, set
`newapi_vpn_network` (e.g. `easyconnect-tju`) so the `app` container joins the
external network. Channels can then configure proxy routing (such as
`socks5://easyconnect-tju:1080` in channel settings / `setting.proxy`).
Do not claim connectivity until the proxy path has been explicitly verified end-to-end.

## Optional public NewAPI administration

`task ops:newapi:origin:deploy` deploys a dedicated HAProxy systemd service on
8443, forwarding only the configured NewAPI hostname to loopback port 3000.
It leaves an existing 443 listener untouched and refuses to take over an active
system HAProxy service. Provision the certificate and private key together at
`/etc/tjuclaw-newapi-origin/tls.pem` (root, `0600`) before deployment.
The origin TLS bundle is separate from the browser-facing EdgeOne certificate;
a private self-signed origin bundle requires an EdgeOne origin policy accepting
that certificate and does not provide public-CA origin identity verification.
Track its expiry and rotate it separately from EdgeOne's automatic edge renewal.

Configure a dedicated EdgeOne hostname, HTTPS origin port 8443, and matching
origin Host. Enable forced HTTPS and respect the origin's `Cache-Control: no-store`
for this administration/API host. Keep public registration disabled and verify
actual HTTPS login after certificate deployment and DNS propagation. No default
administrator credentials or public DNS changes are performed by this role.

### Optional authentication API origin routing

When `newapi_origin_auth_enabled` is set to `true`, the dedicated HAProxy 8443 listener
multiplexes incoming requests between NewAPI (`newapi_origin_hostname`, e.g. `newapi.tjuclaw.cloud`)
and the product authentication API (`newapi_origin_auth_hostname`, e.g. `auth.tjuclaw.cloud`):

- **Certificate requirement (dual SANs)**: The single TLS bundle specified by `newapi_origin_tls_pem`
  (default `/etc/tjuclaw-newapi-origin/tls.pem`) must cover **both** `newapi_origin_hostname`
  and `newapi_origin_auth_hostname` (via Subject Alternative Names, or Common Name if SAN is absent).
  Preflight uses `openssl x509 -checkhost` to verify both hostnames against the PEM bundle and
  fails closed if either hostname does not strictly match. Wildcard or multi-domain SAN certificates
  are verified strictly against each target FQDN.
- **Routing & Path rewrite**: Requests matching `newapi_origin_auth_hostname` have exact path `/`
  redirected via 302 to `newapi_origin_auth_redirect_target` (default `https://app.tjuclaw.cloud/auth/login`).
  API requests starting with `/api` or `/api/` are stripped of the `/api` prefix (rewritten to `/`
  or `/...`) and forwarded to `auth_backend` (`127.0.0.1:18080`). Requests to other paths are denied
  with HTTP 404.
- **Privacy & security rule ordering**: `http-request set-log-level silent if is_auth_host` is
  evaluated immediately upon host identification, **before** any authorization, routing, path rewrite,
  or host deny/redirect rules. This ensures sensitive query parameters, tokens, or credentials on
  auth endpoints are never emitted to HAProxy logs even during early-exit rejections.
- **Strict host ACLs**: HAProxy uses exact host token matching (`hdr(host) -i <hostname>`),
  preventing domain suffix collision attacks (e.g. `auth.tjuclaw.cloud.evil`).

## Validation boundaries

`task ops:test` checks local deployment contracts, including identity secret
preservation and failure on missing SMTP. Simulation does not start Kratos,
send mail, or prove production authentication. Real service health, email
flows, origin TLS, and EdgeOne routing require separate live checks.
