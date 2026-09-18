# Repository Guidelines

Single source of truth for AI assistants working in this integration checkout.
Do not add parallel tool-specific rule files. Update this file when commands,
layout, or conventions change. Before architecture work, read local `CONTEXT.md`
when present; historical Wiki material is not current product authority. Do not
publish private decisions into Docs without explicit approval.

## Project Overview

TJUClaw is a campus action agent for Tianjin University students: capture a goal,
call campus tools, operate an isolated workspace, and deliver inspectable results.
It is not a chatbot shell, a generic RAG app, or a Pi UI wrapper.

This private integration repo (`tjuclaw`) pins Git submodules and owns Docs, ops,
and combination checks. GitHub is the development authority; GitLab is a one-way
competition mirror. Current implemented slice: same-origin email OTP or password auth
(password still requires a verified email), knowledge workspace after login
(`/api/libraries|entries|sessions|account/model`, publish/subscribe/market, local file
blobs, note search), draft task save, and public-course CLI. Agent execution, WeKnora
retrieval, COS, and SSH are not wired yet — do not claim runs have started or completed.


Public surfaces:

- `https://tjuclaw.cloud` — Docs homepage, documentation, downloads (`wiki.tjuclaw.cloud` is a compatible Docs alias)
- `https://app.tjuclaw.cloud` — product Web app; browser auth stays under `/api/*`
- `https://draw.tjuclaw.cloud` — static Excalidraw board (local persistence only; no product auth)
- `auth.tjuclaw.cloud` — API origin, not a browser app origin

Keep Docs and client deployments independent.

## Architecture & Data Flow

```text
Browser / Tauri WebView
  → same-origin /api/*  (Vite or EdgeOne/Nginx strips /api once)
    → Go net/http API   (routes have no /api prefix)
      → Kratos session + Cap proof  (ZITADEL kept only for paired rollback)
      → TASK_DATA_DIR file store     (single API process; draft tasks and knowledge)
      → optional PostgreSQL task/run/library stores


Public crawler (Bun + dedicated PostgreSQL per region) → RSS / replay / 对象存储 archive
  campus sources on the CN Compose host; Microsoft/OneDrive on managed-region Talos
  writing the same 对象存储 bucket; private library ACL stays in the Go API

WeKnora (isolated Compose) → document ingest / retrieval / tenant API keys
  loopback UI :18180 and app :18181; omp uses WEKNORA_BASE_URL + X-API-Key
  not product identity; not a public origin; not library ACL

tjucli / tjucli-server → public course catalog (cs.tjuse.com)
  sandbox grants via TJUCLI_GRANTS_FILE; no campus login credentials
```

- `auth.Gateway.RequireSession` is the protected-API gate. Ownership comes from
  the provider `Identity.ID`. Never trust a request body/path user id. Another
  identity's task, library, or entry returns the same 404 as a missing record.
- Browser sessions are HttpOnly, host-only cookies. Vite and Nginx strip `/api`
  once; Go must not register `/api` prefixes. Native clients need a separately
  reviewed session transport — no relaxed CORS, no cookies stored as bearer tokens.
- Authentication does not imply verified email, campus authorization, or workspace
  ownership. Check each property explicitly.
- Never auto-link existing accounts by email. Keep the old identity database until
  the Kratos OTP cutover is verified.
- Crawler owns configured public sources only. Never share a crawler database with
  identity, product API, WeKnora, or another regional crawler. One process crawls
  one source at a time; run Microsoft attachments on managed-region instead of opening a
  second source on the CN box. `task ops:crawler:deploy` is campus Compose only.
  The external crawler is a Flux app in `agentwego/infra`, not an Ansible host.
- WeKnora is the knowledge engine. Never share its database with Kratos, the
  crawler, or the product API. Do not merge WeKnora users with product identities.
  Do not enable its Docker sandbox or publish its UI.
- `cli/skills/tjucli/` must be loaded into the product runtime, not only the
  developer's global Pi. Current CLI scope is public courses.

## Key Directories

| Path | Owns |
| --- | --- |
| `frontend/` | Public submodule `tjuclaw-client`. React UI, Vite, Tauri shell |
| `frontend/src/` | Shared Web/native UI: `auth.tsx`, `workspace.tsx`, `product.tsx` |
| `frontend/src/components/ui/` | Owned shadcn-style primitives (`button`, `dialog`, `otp-input`) |
| `frontend/src-tauri/` | Tauri v2 host, CSP, native packaging |
| `backend/` | Private submodule `tjuclaw-server`. `cmd/api` composition; `internal/auth`, `internal/task`, `internal/run`, `internal/library` |
| `cli/` | Private submodule `tjucli`. `cmd/tjucli`, `cmd/tjucli-server`, `internal/tjucli`, `skills/tjucli/` |
| `crawler/` | Private submodule `tjuclaw-crawler`. Bun ingest, RSS/replay, archive |
| `docs/` | Next.js 16 + Fumadocs; content in `docs/content/docs/` |
| `draw/` | Static Excalidraw board for EdgeOne (`draw.tjuclaw.cloud`); own lockfile |
| `ops/` | Auth compose, Ansible, CI notes. Inventories stay in ignored `ops/local/` |
| `scripts/` | Dev ports, git policy, auth stack, GitLab release helpers |
| `private/`, `research/` | Local only. Never copy into Docs, client `src/`, or Docker build inputs |

Each component owns its lockfile, version, and CI. Root pnpm workspace is `docs/`
only; `frontend/` and `draw/` have separate lockfiles. Do not treat submodule dirs as ordinary
folders.

## Development Commands

Root `Taskfile.yml` is the command entry. In agent sessions prefix with `rtk`.
Do not load root `.env.local` (PAT-bearing) into Task or client builds.

```bash
rtk task setup          # frozen pnpm (root+frontend+draw), bun (crawler), git hooks
rtk task doctor
rtk task dev            # Web :5173 + docs :3000 + Kratos API :8080 with Air reload (Docker)
rtk task check          # portable lint + types + tests + git:check
rtk task build          # web, docs, api, cli (not native)
```

| Task | What |
| --- | --- |
| `task web:dev` | Vite on `127.0.0.1:5173`; reclaims this checkout's listener only |
| `task auth:dev` | Isolated Kratos/PostgreSQL/Cap/Valkey + API `:8080` (Air reloads on Go changes) |
| `task api:dev` | Low-level API on `:8000` with Air; never reclaimed by `task dev` |
| `task docs:dev` | Docs on `:3000` (occupied port is reported, not killed) |
| `task draw:dev` / `task draw:build` | Excalidraw board on `:5175`; static `draw/dist` for EdgeOne |
| `task cli:build` / `task cli:test` | `cli/bin/tjucli`, `cli/bin/tjucli-server`; `go test -race ./...` |
| `task cli:server:dev` | Requires `TJUCLI_GRANTS_FILE` — see `cli/TOOL_SERVER.md` |
| `task crawler:setup` / `task crawler:dev` | Bun feed on `:3031`; no crawl unless `CRAWLER_SOURCES_FILE` |
| `task crawler:crawl` / `task crawler:import` | One-shot real sources vs synthetic fixtures |
| `task crawler:weknora:inject` | Push derived Markdown into local WeKnora; needs `WEKNORA_API_KEY` and `WEKNORA_KNOWLEDGE_BASE_ID` |
| `task weknora:up` / `task weknora:down` | Isolated WeKnora on `:18180`/`:18181`; down keeps volumes |
| `task linux:build` / `task windows:build` / `task android:build` | Host-specific; Android is unsigned arm64 debug APK |

`task dev` uses real SMTP from ignored `ops/auth/.env.local` by default. Set
`AUTH_DEV_MAIL_MODE=captured` for Mailpit. Disposable tests always use captured
mail. `task auth:down` keeps `ops/local/auth-dev/` identities. Pair a different
API with `API_PROXY_TARGET`. Smoke a running dev proxy with
`node scripts/auth-dev-smoke.mjs`.

Ops deploy tasks (`task ops:api:deploy`, `task ops:identity:deploy`, …) need
explicit ignored inventories and verified artifacts. NewAPI is an operations
gateway, never a second product identity. WeKnora is the knowledge engine on
loopback only; `task ops:weknora:deploy` needs spare RAM and must not share the
2 GiB core host. Cap running does not enforce captcha until the API verifies
tokens. Read `ops/auth/README.md` before auth policy or deploy changes. Never
apply an isolated identity policy to a shared cluster.

## Code Conventions & Common Patterns

**Git.** Explicit-path staging only — never `git add .`. No commit/tag/push
without task authorization. Subject format (hooks enforce emoji + staged version):

```text
EMOJI [vMAJOR.MINOR.PATCH] type(scope): summary
🔧 [v0.0.26] chore(repo): establish repository conventions
```

| feat ✨ | fix 🐛 | docs 📝 | refactor ♻️ | perf ⚡ | test ✅ | chore 🔧 | ci 👷 | build 🚀 | revert ⏪ |

`VERSION` must equal the **staged** `package.json` of the repo being committed
(root vs `frontend/` vs `crawler/` vs `cli/`). `release` is the production and
direct-iteration branch; keep `dev`. Do not force-add ignored files.

**Frontend.** Follow `frontend/UI.md`. Semantic tokens in `src/product.css`
(OKLCH, `data-theme`, `data-accent`). Appearance store is
`src/lib/appearance.ts` (`useAppearance` / `setAppearance`, key
`tjuclaw.appearance.v1`). No second theme system, no `next-themes`, no extra
router/form/global store until current page boundaries are exceeded. Chinese UI
copy; no i18n package. Native inputs over custom pickers. Icon-only buttons need
an accessible name; keep focus rings.

Path-based entry in `frontend/src/main.tsx`: `/workspace` → `workspace.tsx`,
`/preview/appearance` → `product.tsx`, `MODE=audit` → `audit.tsx`, else `auth.tsx`.
Audit mode must not pull `private/` into a normal client build.

Same-origin fetch via `authRequest` in `frontend/src/lib/auth.ts`: path must start
with `/api/`, `credentials: 'same-origin'`, `cache: 'no-store'`, `redirect: 'error'`,
15s timeout. Validate JSON; map `error.id` to copy. Do not log emails, OTPs, Cap
proofs, or session tokens. After login/logout, read the real server session — do

not optimistic-claim security mutations. Knowledge notes persist as Markdown; old tasks stay draft.

**Backend.** Stdlib `net/http.ServeMux`. Parse config at startup; missing identity
config is 503, never a fake authenticated response. Application errors:

```json
{"error":{"id":"stable_machine_code"}}
```

Bound bodies (tasks: 16 KiB). Exact same-origin JSON mutations; SameSite is not a
substitute for origin checks. Never cache auth. Logs omit bodies, cookies,
authorization headers, codes, and full auth query strings. No Admin routes, no
caller-controlled upstream URLs or forwarding headers.

**CLI.** JSON envelopes `{"ok":true,"data":{},"meta":{}}` /
`{"ok":false,"error":{"code":"...","message":"..."}}`. Remote mode
(`TJUCLI_MODE=remote`) never falls back to direct provider. Downloads stay in the
CLI workspace; server never receives an output path.

**Crawler.** One source at a time; `(source, cursor)` events; do not prune history
during bootstrap. WeChat/Lake tokens from env only — never in source config or
feeds. Dynamic lists stay `complete: false` so missing list items do not delete
history.

## Important Files

| File | Why |
| --- | --- |
| `Taskfile.yml` | Command entry; loads `.env.toolchain.local` only |
| `DEVELOPMENT.md` | Frontend/API boundary and acceptance |
| `CONTRIBUTING.md` | Git, versioning, secrecy |
| `frontend/UI.md` | Product UI contract |
| `frontend/vite.config.ts` | Ports, `/api` proxy, `fs.deny` for env/certs/`private/` |
| `frontend/src/main.tsx` | Client entry |
| `frontend/src/lib/auth.ts`, `lib/tasks.ts`, `lib/appearance.ts` | Transport, tasks, theme |
| `backend/cmd/api/main.go` | Mux, stores, graceful shutdown |
| `backend/internal/auth/auth.go`, `zitadel.go` | Session gate; ZITADEL target + Kratos rollback |
| `backend/internal/task/handler.go` | `/tasks` ownership |
| `cli/cmd/tjucli/main.go`, `cli/cmd/tjucli-server/main.go` | CLI vs grant-gated tool server |
| `cli/TJUCLI.md`, `cli/TOOL_SERVER.md` | Command and grant contracts |
| `crawler/src/index.ts`, `crawler/src/app.ts` | Feed server + scheduler |
| `ops/auth/README.md`, `ops/ci/README.md` | Auth policy; CI/release |
| `ops/weknora/README.md` | Isolated WeKnora knowledge stack |
| `docs/src/`, `docs/content/docs/` | Fumadocs app and reviewed content |

## Runtime/Tooling Preferences

| Area | Tool |
| --- | --- |
| Root + Docs | Node `>=22.12.0`, `pnpm@11.3.0`, workspace package `docs` only |
| Frontend | Separate pnpm lockfile; Vite 8; React 19; Tailwind 4; Tauri 2 |
| Backend / CLI | Go `1.27` (`go.mod`); stdlib HTTP; `pgx` when `DATABASE_URL` is set; Air `v1.67.4` via `go run` for live reload only |
| Crawler | Bun **1.3.14** (CI pin), `bun.lock` |
| Orchestration | Task 3; Docker for auth/crawler tests; Ansible via `uv` |
| Agent CLI | Prefer `rtk` for eligible commands |

Ports: Web `5173`, draw `5175`, audit desk `1421`, UI tests `1422`, auth tests `1423`,
workspace/audit-ui tests `1424`, docs `3000`, crawler `3031`, WeKnora UI `18180`,
WeKnora app `18181`, Kratos `4433`, Kratos-backed API `8080`, raw API `8000`,
tool server `18090`, Mailpit `8025`. `scripts/dev-ports.mjs` clears this
checkout's Web/API listeners; unknown processes and `:8000` stay.

Vite `/api` proxies to `API_PROXY_TARGET` or `http://127.0.0.1:8080`.
Tauri reads `frontend/package.json`; Rust crate version is internal. Do not
merge frontend or draw into the root pnpm workspace.


Client Actions own Web/Linux/Android/Windows builds and UI/workspace regressions.
Integration Actions own pinned-component checks and real Compose/auth regressions.
Do not rebuild native clients because the server changed.

## Testing & QA

No coverage gate is documented. Prefer the smallest suite that hits the changed
contract. Do not run two browser suites at once against shared `frontend/dist`.

```bash
rtk task check                 # portable default
rtk task ui:install            # once
rtk task ui:test               # appearance, keyboard, six viewports × light/dark
rtk task workspace:test        # mocked /workspace contract — not persistence proof
rtk task auth:test             # real Kratos + Cap + captured mail + Nginx CSP
rtk task api:test              # go test ./... ; race: (cd backend && go test -race ./...)
rtk task cli:test
rtk task crawler:test          # CRAWLER_TEST_DATABASE_URL or ephemeral Docker Postgres
rtk pnpm test:git && rtk pnpm test:tooling
rtk task ops:test
```

- `task auth:test` needs Docker, Go, Chromium. Project `tjuclaw-auth-test` is
  disposable (volumes removed). It does not touch `tjuclaw-auth-dev` or
  production mail. Evidence in ignored `test-results/`.
- `workspace:test` mocks the browser; real task ownership still needs `auth:test`.
- Crawler tests must never use identity/runtime `CRAWLER_DATABASE_URL`.
- Audit captures stay in ignored `private/audit/`, never client assets.
- Mocked error tests supplement, not replace, real cookie/email integration.
- Local Compose/CI YAML is not evidence of a live deployment.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
