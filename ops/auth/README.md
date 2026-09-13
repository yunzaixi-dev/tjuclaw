# Email Authentication

The selected replacement is **ZITADEL v4.17.3** with a unified email entry and
self-hosted Cap. See [the ZITADEL boundary and migration guide](ZITADEL.md).
Implementation and acceptance are in progress; these configuration files do not
by themselves prove that production has switched.

The Kratos material below is retained for a coordinated rollback. It must not
override the newer ZITADEL decision or be deployed into a shared identity cluster.

## Legacy Kratos configuration

## Deployed domain layout

The public homepage, documentation and downloads use `https://tjuclaw.cloud`.
The product browser origin is `https://app.tjuclaw.cloud`; all browser authentication
requests stay under its `/api/*` path. `auth.tjuclaw.cloud` is the upstream gateway.
Set production `APP_PUBLIC_URL` and Ansible `identity_app_url` to the app origin.
Kratos configuration and its `.env.kratos` URL overrides must agree; changing the
environment requires recreating the Kratos container, not just restarting it.
Preserve database volumes, identity schemas, cookie/cipher secrets and host-only cookies.
The policy examples below remain examples for the separately named reference domain.

## Scope

Email one-time-code login and registration only. Registration verifies possession
of the email and creates a Kratos session through the `session` hook. No passwords,
password reset, social login, locally generated codes, or second identity store.
An additional verification UI handles existing unverified identities. Losing
access to a mailbox requires recovering it with its provider, not bypassing auth.

The checked-in policy targets `https://tjuclaw.agentwego.com`. It is a reviewed
configuration input, **not evidence that the domain or existing cluster has been
configured**. The local integration is pinned to `oryd/kratos:v26.2.0`.

## Local Development

```bash
rtk task auth:up
rtk task auth:dev
# In another terminal:
rtk task web:dev
```

- Browser: `http://127.0.0.1:1420`.
- Captured mailbox: `http://127.0.0.1:18025`. Use synthetic `@example.com` addresses.
- Kratos public API: loopback 14433. No admin/database/SMTP host ports.
- Stop: `rtk task auth:down`; identities remain in a dedicated Docker volume.
- Regression: `rtk task auth:test`; separate ports 1423/18089/14434/18026 and
  project `tjuclaw-auth-test`, with no real email delivery.

`task dev` remains infrastructure-free. For an existing identity deployment,
prepare ignored `.env.auth.local` from root `.env.auth.example` and use
`task auth:serve`. The API must be able to reach the configured Kratos origin.
Vite's `API_PROXY_TARGET` is server process configuration, not a `VITE_*` secret.

## Same-Origin Production Contract

```text
https://tjuclaw.agentwego.com/
  /auth/*        React authentication pages
  /app           Session-checked account entry
  /api/auth/*    Go application session boundary
  /api/kratos/*  Go allowlist -> internal Kratos public API
```

Configure Go with `APP_PUBLIC_URL=https://tjuclaw.agentwego.com` and an internally
reachable `KRATOS_PUBLIC_URL` origin, without a path. Configure Kratos's
`serve.public.base_url` with the external `/api/kratos/` path. Preserve `/api`
stripping at the web proxy once, not twice.

Run Kratos without `--dev` in production, with a durable database and strong
secret-store-injected `DSN`, `SECRETS_COOKIE`, `SECRETS_CIPHER`. Keep cookies
host-only (do not set `.agentwego.com` as their domain), Path `/`, SameSite Lax,
Secure and HttpOnly. Mount policy, identity schema and `mail/` read-only.
Run `courier watch` as a supervised worker, or `serve --watch-courier` for a
single-process deployment. A missing courier means queued messages do not send.

Before changing an existing cluster, inspect its version and identity schemas.
Do **not** replace other applications' schemas, cookie secrets, return URLs or
enabled methods blindly. This policy disables other login methods and is suitable
for an isolated TJUClaw identity boundary; a shared deployment needs a reviewed
migration or separate Kratos instance. Preserve existing identity schema IDs.
Existing password-only identities need an explicit code-credential migration;
the fallback setting is deliberately not enabled as a shortcut.

Terminate TLS at the trusted ingress, enforce HTTPS and HSTS there, and prevent
direct public access to Go, Kratos, admin/database/SMTP services. Nginx includes
native rate limiting and disables authentication access logs. Apply equivalent
query/body redaction at **every** upstream proxy and telemetry collector.
Ingress real-IP configuration must trust only known proxies; never trust arbitrary
`X-Forwarded-For`. With an incorrectly configured proxy, per-IP limits may count
all users together. Local Vite does not provide production rate limiting.

## Resend

Kratos can use Resend directly through SMTP; there is no need for a custom Go
mailer, webhook, HTTP-to-SMTP bridge or Resend SDK.

1. Verify a sender domain in Resend and install its requested DNS records.
   `login@agentwego.com` is an example sender only; use a domain you actually
   verified. The application hostname and sender domain need not be identical.
2. Create a sending API key restricted to the appropriate domain where available.
3. Inject the settings from `resend.env.example` into Kratos and its courier.
   For implicit TLS use `smtps://resend:API_KEY@smtp.resend.com:465/`; alternatively
   use `smtp://resend:API_KEY@smtp.resend.com:587/` with STARTTLS enforced.
4. URI-encode the credential when needed. Never use `skip_ssl_verify=true` or
   `disable_starttls=true` against Resend. The latter appears only in local Mailpit.
5. Check the queue, delivery status, bounces and rate limits. API acceptance is not
   proof of inbox delivery. Do not log SMTP credentials or email bodies.
6. Test with an authorized real recipient before opening registration; monitor
   abuse and email quotas. Use domain-restricted keys and rotation procedures.

Chinese HTML and plaintext templates are selected by Kratos for login,
registration and verification. They use Kratos's actual code/expiry variables.
The OTP stays out of the subject and no tracking pixels are included.
Do not put these credentials in root PAT-bearing `.env.local`, Vite variables,
Docker build arguments, client bundles or checked-in deployment manifests.

## Deployment Acceptance

- Confirm trusted TLS, hostname, return URLs and absence of public Admin API.
- Check cookies in a real HTTPS browser: Secure, HttpOnly, host-only and Lax.
- Register, receive the real message, reject a wrong/used code, resend, reload,
  login again, restore a session and confirm logout makes `/api/auth/session` 401.
- Check expiry, upstream downtime, CSRF rejection and rate-limit responses.
- Verify email is marked verified, audit logs are redacted and the courier drains.
- Test existing identities/schema migration and backup/rollback before rollout.
- Native Tauri authentication is not implemented by this browser-only adapter.
  Do not enable wildcard CORS or store browser cookies as native bearer tokens.

Official references, retrieved for the pinned integration:

```text
https://resend.com/docs/send-with-smtp
https://www.ory.com/docs/kratos/passwordless/one-time-code
https://github.com/ory/kratos/blob/v26.2.0/embedx/config.schema.json
https://github.com/ory/kratos/tree/v26.2.0/selfservice/strategy/code
https://github.com/ory/kratos/blob/v26.2.0/selfservice/flow/logout/handler.go
```
