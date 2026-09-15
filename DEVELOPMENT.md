# Development Baseline

## Boundaries

- React + Vite owns the product UI; Next.js is documentation only.
- Go's standard-library HTTP server owns application APIs. Keep business code
  under `backend/internal/<feature>/`; `cmd/api` is composition and lifecycle.
- Kratos is the active identity authority. Never create parallel user/password
  databases, verification codes, JWT issuers, or localStorage login state. The API
  encrypts the Kratos session token in HttpOnly cookies; every protected request
  must still validate that session and a verified email. ZITADEL remains a paired
  rollback only (`AUTH_PROVIDER=zitadel`).
- Browser traffic is same-origin `/api/*`. Vite and Nginx remove `/api` once;
  Go routes do not include that prefix. Native clients need a separately reviewed
  native session transport, not relaxed CORS or browser cookies stored as tokens.
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
  HTML or follow caller-supplied redirects. New emails are verified before access.
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

## Task Workspace Acceptance

The first workspace slice saves authenticated task goals. Saved tasks have status
`draft`; display them as saved, without claiming that an Agent has started or
completed execution. Keep `/app` as the account surface and `/workspace` as the
separate task surface. Preserve the appearance preview and authentication routes.

Task endpoints use the same-origin `/api/tasks` browser boundary. The API must
validate the selected identity provider's session for each request and derive ownership from its
`Identity.ID`. A task owned by another identity must return the same 404 as a
missing task. Never accept ownership, status or timestamps from the request body.

`TASK_DATA_DIR` is server-only runtime configuration. The initial file store is
for a single API process and must retain records across restarts. Do not share it
between API replicas or treat it as the future workspace file service. Keep the
container root read-only and mount only the designated data volume for writes.

Run `task workspace:test` for the mocked browser contract, and `task auth:test`
for real Kratos/API task acceptance. Mocked transport checks are not evidence of
working persistence or identity isolation. Run `go test -race ./...` in `backend/`
for concurrent storage behavior. Do not run browser suites concurrently against
the shared `frontend/dist` output.
