# ZITADEL email authentication

The replacement identity provider is ZITADEL **v4.17.3**, the latest stable release
verified on 2026-09-13. The unified browser flow and real local integration checks
are implemented. Production cutover still requires coordinated API/client delivery;
local tests and rendered deployment configuration do not establish a live deployment.

## Browser and identity boundary

The product uses one email entry for both login and registration. Browser traffic
stays at `https://app.tjuclaw.cloud/api/*`; the ingress removes `/api` once. The Go
API accesses private ZITADEL and Cap endpoints. No service PAT, Cap secret,
verification code, or provider session credential is exposed to JavaScript storage.

ZITADEL creates and verifies email codes. Cap proofs are verified server-side
before account creation, sending, or resending; rendering a widget alone is not
protection. Mutation endpoints require the exact application Origin and JSON.
Authentication responses must be `Cache-Control: no-store`. The gateway forwards
only Cap challenge/redeem operations; Cap administration and siteverify stay private.

The gateway encrypts ZITADEL session credentials into host-only, HttpOnly,
SameSite=Lax cookies with Secure enabled on HTTPS. The authenticated cookie and
pending-flow cookie use separate authenticated-encryption purposes. A pending flow
is never sufficient to access tasks. Each protected request must validate the
client's actual ZITADEL session token, expiry, successful email factor, active human
user, verified primary email, and configured organization. A privileged PAT reading
a session by ID without validating its session token is not authentication.

Pending challenges and attempt limits are held by one Go API process for ten
minutes. Restarting that process expires unfinished browser flows; users start
again with a fresh Cap proof. Authenticated cookies survive a restart when the
encryption key is retained, but every request still checks the provider session.
Multiple API replicas require a shared, atomic pending-flow and rate-limit store
before deployment.

## First enrollment versus an existing email

ZITADEL v4.17.3 requires a verified email before adding its OTP Email factor. It
does not automatically verify an unverified email when checking a Session OTP.
The unified browser interface therefore uses two internal paths:

1. **New or unverified human:** request a ZITADEL email verification code. The
   user's submitted code must succeed at `POST /v2/users/{id}/email/verify`.
   Only after this proof succeeds may the gateway enable OTP Email and establish
   the provider session. A private, returned ZITADEL OTP challenge bridges that
   already-verified email proof into the session factor without sending a second
   email. The returned challenge never reaches the browser or logs.
2. **Existing verified human:** enable the OTP Email factor if needed and request
   a Session OTP email. The submitted code must satisfy the ZITADEL session check.

Never set `isVerified: true` merely because a visitor typed an email or solved Cap.
Never call the private enrollment bridge after a failed or reused verification
code. If the session cannot be established after consumption of the enrollment
proof, fail closed and restart using the existing-user path. Changing email,
resending and concurrent submissions must not reuse a consumed proof.

New human IDs are explicit UUIDs so application ownership remains compatible with
existing task/run storage. Queries are restricted to the configured organization
and exact login name. Do not automatically attach pre-existing application data to
a matching email address. Future migrations with existing identities require an
explicit mapping of verified provider subjects.

## Server configuration

Copy root `.env.auth.example` to ignored `.env.auth.local` for `task auth:serve`.
Production configuration is root-owned mode 0600. Required settings are:

| Setting | Purpose |
| --- | --- |
| `AUTH_PROVIDER=zitadel` | Select one active provider |
| `APP_PUBLIC_URL` | Exact browser origin |
| `ZITADEL_URL` | Private origin, without a path |
| `ZITADEL_DOMAIN` | Instance Host, including port when configured |
| `ZITADEL_ORG_ID` | Organization authorized for this product |
| `ZITADEL_TOKEN` | Dedicated `IAM_LOGIN_CLIENT` PAT |
| `AUTH_COOKIE_KEY` | Base64-encoded 32 random bytes; retain across restarts |
| `CAP_URL` | Private Cap origin |
| `CAP_SITE_KEY` | Configured Cap site identifier |
| `CAP_SECRET_KEY` | Server-only siteverify secret |

Bootstrap machine-owner credentials stay outside the API runtime. The login client
role in this release contains session operations and user credential management;
do not give the public browser a PAT. Keep PostgreSQL, bootstrap files and provider
administration private. Preserve the ZITADEL master key and persistent database.

The deployment entry is `task ops:zitadel:deploy` with ignored
`ops/local/zitadel.yml`. It provisions an isolated PostgreSQL and ZITADEL service;
it does not delete Kratos or change the API's selected provider. SMTP is ZITADEL's
native channel. Version 4.17.3 supports implicit TLS on port 465 with TLS enabled;
use a verified sender and never disable certificate verification for production.
The profile decodes percent-encoded credentials from the existing root-only SMTP
environment and requires `smtps` on port 465. Compose's raw env-file format preserves
literal `$` in passwords; use Docker Compose 2.30 or newer. Bootstrap creates a
machine owner and a separate login client, with PAT files in a private `bootstrap/`
directory. Configure `zitadel_pat_expiration` and rotate the runtime PAT before
expiry; the default is 2027-09-13. The owner PAT must never enter API configuration.

## Acceptance and coordinated cutover

`task auth:test` uses the dedicated `tjuclaw-auth-test` Compose project, synthetic
accounts, a captured mailbox, real Cap proofs, Go and Chromium behind Nginx with
the production CSP. Dedicated volumes are removed after the run. Its databases
and credentials are independent of production and interactive services. Check
the following before switching the API and client together:

- New-email proof, existing-email login, no premature error on the code screen.
- Invalid, expired and reused codes; missing/invalid Cap proof; resend cooldown.
- Session reload, expiry and real provider revocation on logout.
- Two-user task ownership and refusal of forged or pending cookies.
- Exact-Origin enforcement, private provider headers and no cached authentication.
- Light/dark layouts on mobile and 1024×600, with no card clipping or inner scroll.

Retain the prior API artifact, matching client build, Kratos configuration and its
database for rollback. Do not drop identity tables or remap resource owners during
cutover. If reverting, restore the matching client and `AUTH_PROVIDER=kratos` /
`KRATOS_PUBLIC_URL` configuration together. A healthy container alone does not prove
that real email delivery, browser cookies or task ownership work in production.

## Primary contract references

- [Stable release v4.17.3](https://github.com/zitadel/zitadel/releases/tag/v4.17.3)
- [Session API proto](https://github.com/zitadel/zitadel/blob/v4.17.3/proto/zitadel/session/v2/session_service.proto)
- [Email verification command](https://github.com/zitadel/zitadel/blob/v4.17.3/internal/command/user_v2_email.go)
- [Session OTP preconditions](https://github.com/zitadel/zitadel/blob/v4.17.3/internal/command/session_otp.go)
- [Bootstrap settings](https://github.com/zitadel/zitadel/blob/v4.17.3/cmd/setup/steps.yaml)
- [SMTP TLS implementation](https://github.com/zitadel/zitadel/blob/v4.17.3/internal/notification/channels/smtp/channel.go)
