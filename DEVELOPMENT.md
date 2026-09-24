# Development Baseline

## Boundaries

- React + Vite owns the product UI; Next.js is documentation only.
- Go's standard-library HTTP server owns application APIs. Keep business code
  under `backend/internal/<feature>/`; `cmd/api` is composition and lifecycle.
  Local `task dev` / `task api:dev` reload the API with Air; production and
  `task auth:test` still build a one-shot binary.
- Kratos is the active identity authority. Never create parallel user/password
  databases, verification codes, JWT issuers, or localStorage login state. The API
  encrypts the Kratos session token in HttpOnly cookies; every protected request
  must still validate that session and a verified email. ZITADEL remains a paired
  rollback only (`AUTH_PROVIDER=zitadel`).
- Browser traffic is same-origin `/api/*`. Vite and Nginx remove `/api` once;
  Go routes do not include that prefix. Native clients need a separately reviewed
  native session transport, not relaxed CORS or browser cookies stored as tokens.
- Native runtime gate: the bundled Android WebView currently loads from
  `http://tauri.localhost/`. On an installed x86_64 debug APK, a request to
  `/api/auth/session` returned the SPA HTML with status 200, not API JSON.
  A package build or visible login screen therefore does not establish native
  authentication. Before calling any native platform functional, verify its
  packaged WebView reaches the real `/api/auth/flow` JSON contract, then test
  login, session restoration, protected note writes, and logout. Keep the
  Kratos-backed HTTPS origin and HttpOnly session boundary intact; native
  transport requires its own security review.
- WeKnora is the knowledge engine only. Do not proxy it as `/api`, mix its
  users with Kratos, or treat a WeKnora tenant key as a product session.
  omp reads WeKnora over loopback with an explicit API key after an operator
  creates the knowledge base. Library ACL stays in the Go API.

## Frontend

- Follow `frontend/UI.md`: owned shadcn-style components, Radix for complex
  interaction, native form elements, semantic colors, one appearance store.
- Keep API transport/types with the feature. Use credentialed same-origin fetch,
  bounded request lifetimes where applicable, and explicit HTTP errors.
- Model pending, success, validation failure, expired flow, unavailable service
  and retry. Disable duplicate submissions. Do not optimistically claim security
  mutations succeeded. Read the real server session after authentication/logout.
- Unified email login/registration uses the Go `/api/auth/*` contract and Cap.
  Treat provider responses as protocol data; do not render arbitrary upstream
  HTML or follow caller-supplied redirects. Password login uses `/api/auth/password`;
  password registration uses `/api/auth/register` then the existing OTP verification
  flow. New emails are verified before access. OTP-only accounts have no password.
- Emails, codes, Cap proofs and provider session tokens must not be written to
  localStorage, analytics, URLs or console logs. Pending flows use HttpOnly cookies.
- Form labels, visible focus, live status/errors, autocomplete, paste, touch
  targets, reduced motion and narrow-screen overflow are acceptance criteria.
- Do not add a router, form framework or global store until its need exceeds
  the current small, explicit page/feature boundaries.

## Backend

- Parse configuration at startup; reject unsafe public origins. Missing identity
  configuration must return 503, never a fabricated authenticated response.
- Authenticated handlers use `auth.Gateway.RequireSession`. Verify resource
  ownership with the normalized provider `Identity.ID`; never trust a request's user ID.
- Authentication does not imply verified email, campus authorization or workspace
  ownership. Sensitive features must explicitly check their required properties.
- Bind requests to context, set server/upstream timeouts, bound request bodies,
  return deliberate status codes and avoid leaking upstream/private details.
- Use `{"error":{"id":"stable_machine_code"}}` for application errors. Keep provider
  details and service credentials private; a normal OTP sent state is not an error.
- Browser-only proxy: no Admin routes, arbitrary upstream URL, native API flow,
  caller return URL, bearer credential, or caller-controlled forwarding headers.
- Preserve secure HttpOnly host-only cookies and require exact same-origin JSON
  mutations. SameSite is not a substitute for origin validation. Never cache auth.
- Logs must not include request bodies, cookies, authorization headers, codes or
  full auth query strings. Authentication rate limits must be enforced at the
  trusted ingress; a frontend resend countdown is only UX.

## Verification

From the root, using RTK in agent sessions:

```bash
rtk task check
rtk task ui:install
rtk task ui:test
rtk task auth:test
rtk task compose:config
rtk task compose:context
```

`auth:test` requires local Docker, Go and Chromium. It starts isolated ZITADEL,
PostgreSQL, Cap/Valkey, a captured mailbox, the Go API and a production preview
behind Nginx with the production CSP. It does not contact a production mailbox
or identity service. The `tjuclaw-auth-test` project uses synthetic accounts and
removes its dedicated volumes on shutdown. Screenshots stay in ignored
`test-results/`.

Do not run two build tasks concurrently against the same `frontend/dist`.
Run real authentication tests after protocol/config changes and inspect light/
dark mobile/desktop captures after UI changes. Mocked error tests supplement,
not replace, the real email/cookie integration test.

Production delivery and native WebView authentication require separate evidence.
Never describe local Compose, a template, or CI configuration as a live deployment.

## Knowledge Workspace Acceptance

The first workspace slice is a knowledge library, not a task list. After login,
`/workspace` shows an AFFiNE-like tree. A missing library is created as
「我的知识库」 with a deletable 「新手向导」 agent. Notes persist Markdown
through `/api/entries`. Agent chat persists on `/api/sessions`. Custom model
URLs must be public HTTPS; loopback and RFC1918 fail closed. Product NewAPI is
the unconfigured fallback with a daily quota. Old `/tasks` and `/runs` remain
but are not the homepage. Preserve the appearance preview and authentication
routes.

Library endpoints use the same-origin `/api/*` browser boundary. Ownership
comes from the provider `Identity.ID`. Another identity's library or entry
returns the same 404 as a missing record. Never echo API keys or full upstream
URLs. File object ids stay server-side. A subscribed snapshot is read-only;
writes match a missing library. Withdrawn publications disappear from the
market and from new subscriber reads.

`TASK_DATA_DIR/knowledge` is the file-store baseline; `DATABASE_URL` selects
PostgreSQL for libraries, entries, sessions, model records, publications, and
blobs. Do not share that database with Kratos, the crawler, or WeKnora. Local
blobs are not COS.

Run `task workspace:test` for the mocked browser contract, and `task auth:test`
for real Kratos/API acceptance. Mocked transport checks are not evidence of
working persistence or identity isolation. Run `go test -race ./...` in
`backend/` for concurrent storage behavior. Do not run browser suites
concurrently against the shared `frontend/dist` output.
