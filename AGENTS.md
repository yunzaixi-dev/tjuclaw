# TJUClaw Integration Knowledge Base

**Scope:** root integration checkout. `frontend/`, `backend/`, `cli/`, and
`crawler/` are Git submodules with their own rules. Read `CONTEXT.md` before
architecture work; do not copy private decisions or historical deployment notes
into public Docs without approval.

## OVERVIEW

TJUClaw is a Tianjin University campus action-agent platform. This repository
owns integration, Docs, Ops, scripts, and combination checks; product components
are pinned by submodule SHA. GitHub Actions is authoritative; GitLab is a
one-way mirror.

## STRUCTURE

```text
frontend/  React 19 + Vite + Tauri client (GPL submodule)
backend/   Go API and auth gateway (private submodule)
cli/       public-course CLI and grant-gated tool server (GPL submodule)
crawler/   Bun public-source crawler and Replay Feed (private submodule)
docs/      Next.js 16 + Fumadocs site; root pnpm workspace
draw/      independent Vite/Excalidraw static app and lockfile
ops/       Ansible, auth, CI, WeKnora deployment material
scripts/   development, test, OCR, Git, and release automation
private/ research/ ops/local/  ignored local material; never build inputs
```

## WHERE TO LOOK

| Need | Location |
| --- | --- |
| Cross-component commands | `Taskfile.yml` |
| Product decisions and status | `CONTEXT.md` |
| Frontend/API boundary | `DEVELOPMENT.md`, `frontend/UI.md` |
| Docs source and navigation | `docs/content/docs/`, `docs/content/docs/meta.json` |
| Auth policy | `ops/auth/README.md` |
| Production deployment contract | `ops/ansible/DEPLOY.md` |
| API composition | `backend/cmd/api/main.go` |
| Client page dispatch | `frontend/src/main.tsx` |
| CLI dispatch | `cli/cmd/tjucli/main.go` |
| Crawler runtime | `crawler/src/index.ts` |

## CODE MAP

| Symbol | Location | Role |
| --- | --- | --- |
| `App` | `frontend/src/main.tsx` | Path-based lazy page entry |
| `main` | `backend/cmd/api/main.go` | Mux, stores, shutdown |
| `runner` | `cli/cmd/tjucli/main.go` | CLI commands and JSON envelope |
| `runtime` | `crawler/src/index.ts` | Feed server and scheduler |
| `source` | `docs/src/lib/source.ts` | Fumadocs loader and derived routes |
| `Store` | `backend/internal/library/store.go` | Library storage contract; see child rules |
| `CrawlHttpClient` | `crawler/src/ingest/http.ts` | SSRF-safe outbound client; see child rules |

## COMMANDS

Use `rtk` before eligible commands.

```bash
rtk task setup
rtk task doctor
rtk task dev
rtk task check
rtk task build                 # Web, Docs, API, CLI; not native packages
rtk task ui:test               # do not run with another browser suite
rtk task workspace:test        # mocked API contract
rtk task auth:test             # real Kratos/Cap/captured-mail flow
rtk task api:test
rtk task cli:test
rtk task crawler:test
rtk task ops:test
```

Component toolchains are separate: root/Docs use pnpm 11.3; CI uses Node 24;
frontend and draw have separate pnpm lockfiles; crawler uses Bun 1.3.14; backend
and cli use Go 1.27.0. Do not merge them into one workspace.

## CONVENTIONS

- Browser API calls are same-origin `/api/*`; proxy layers strip the prefix once,
  while Go routes do not register `/api` prefixes.
- Session ownership comes from the authenticated provider identity, never a body
  or path user ID. Cross-identity private records return the same 404 as missing.
- Frontend uses `authRequest`, semantic tokens, the existing appearance store,
  Chinese UI copy, native inputs, named icon buttons, and visible focus rings.
- Backend uses stdlib `net/http`, bounded JSON bodies, stable errors shaped as
  `{"error":{"id":"machine_code"}}`, no auth caching, and no arbitrary proxying.
- CLI keeps stable JSON envelopes; remote mode never falls back to direct provider;
  downloads stay in the CLI workspace.
- Crawler uses its own PostgreSQL and safe HTTP client. Dynamic sources remain
  `complete: false`; production crawler does not run OCR.
- Commit subjects are `EMOJI [vVERSION] type(scope): summary`; stage explicit
  paths only. Version must match the staged component `package.json`.

## ANTI-PATTERNS

- Never use `git add .`, force-push, or commit/tag/publish without authorization.
- Never load PAT-bearing root `.env.local` into Task or client builds.
- Never share crawler, WeKnora, Kratos, API, or regional crawler databases.
- Never expose WeKnora UI/app publicly, enable its Docker sandbox, or treat it as
  product identity or library ACL.
- Never put credentials, OTPs, cookies, Cap proofs, private research, audit
  captures, local databases, or ignored `ops/local/` material in source, logs,
  Docs, client assets, Docker contexts, or artifacts.
- Do not treat mocks, YAML, local Compose, health checks, CI success, or an
  artifact build as proof of live deployment, real mail delivery, retrieval,
  campus-source crawling, object storage, SSH, or Agent execution.
- Do not claim the root Apache-2.0 license covers GPL submodules or private code.

## NOTES

`task dev` uses real SMTP unless `AUTH_DEV_MAIL_MODE=captured` is set. Disposable
auth tests use captured mail and isolated state. WeKnora local ports are 18180/18181;
Docs is 3000, Web 5173, Draw 5175, crawler 3031, API 8080, and low-level API dev
8000. Read the child `AGENTS.md` before editing a submodule or a scored hotspot.
