# TJUClaw Project Instructions

Muse Code reads this file as the single source of truth for project rules.
Add or update repository-wide agent instructions here instead of duplicating
them in tool-specific files.

## Project

- Name: TJUClaw
- Documentation: Next.js 16 with Fumadocs.
- Package manager: pnpm.
- Documentation app: `docs/`; content: `docs/content/docs/`; source: `docs/src/`.
- Public entry points: `https://tjuclaw.cloud` serves the existing Docs homepage,
  documentation and downloads; `https://app.tjuclaw.cloud` serves the product Web app.
  Keep Docs and client deployments independent. Browser authentication stays under
  `https://app.tjuclaw.cloud/api/*`; `auth.tjuclaw.cloud` remains the API origin.
  `wiki.tjuclaw.cloud` is retained as a compatible Docs address.
- Private integration repository: `tjuclaw`. Pinned Git submodules: `frontend/`
  (`tjuclaw-client`, public), `backend/` (`tjuclaw-server`, private), `cli/`
  (`tjucli`, private for now), `crawler/` (`tjuclaw-crawler`, private).
  Operations remain in `ops/`.
- Each component owns its dependencies, lockfile, version metadata and CI.
  Root pnpm workspace contains documentation; the client is independent.
- Product CLI instructions: `cli/skills/tjucli/`; these must be explicitly loaded
  into the product runtime, not merely installed in the developer's global Pi.
- React + Vite + Tauri in `frontend/` share source across Web and native clients.
  The Go API is in `backend/`; Next.js is documentation only.
- Root `Taskfile.yml` is the development command entry point. Keep CI tasks and
  README commands aligned. Do not load root `.env.local` into client builds.
- Before architecture work, read local `CONTEXT.md` when available. Historical
  Wiki content is not authoritative for current private product decisions.
  Do not publish private decisions into the Wiki without explicit approval.
- Follow `frontend/UI.md` for product UI components and appearance state.
  Use shared semantic tokens and `src/components/ui/`, not parallel theme systems.
- Follow root `DEVELOPMENT.md` for frontend/API boundaries and acceptance checks.
  Kratos is the only identity authority; browser auth stays same-origin.
  Read `ops/auth/README.md` before changing authentication policy or deployments.
  Never apply the isolated Kratos policy blindly to a shared identity cluster.

## Common Commands

- Development: `task dev`
- Documentation: `task docs:dev` starts Docs on 3030.
  An occupied port is reported without terminating unrelated processes.
  `task docs:build` builds the documentation app.
- Campus tools: `task cli:build` builds `cli/bin/tjucli` and `cli/bin/tjucli-server`;
  `task cli:test` tests all CLI/service packages. `task cli:server:dev` requires
  `TJUCLI_GRANTS_FILE`; see `cli/TOOL_SERVER.md`. Current provider scope remains public courses.
- RSS feeds: `task crawler:setup` installs locked Bun dependencies;
  `task crawler:import` explicitly imports synthetic fixtures; `task crawler:dev`
  starts the loopback RSS/replay service on 3031. `task crawler:check` and
  `task crawler:test` run in `task check`. Bun 1.3.14 is the CI runtime.
  Crawler owns source events only; no user-private libraries or production deployment
  are implied. CI checks out its pinned SHA with a separate read-only deploy key.
- Checks: `task check`
- Portable build: `task build`
- Native builds: `task linux:build`, `task windows:build`, `task android:build`
- Ansible adoption: `task ops:check` validates syntax and `task ops:test` verifies
  local rendering and deployment rollback; `task ops:discover` reads
  an explicitly configured host; `task ops:origin:render` writes a local HAProxy
  candidate only. `task ops:api:deploy` updates the isolated API service using an
  explicitly configured artifact; see `ops/ansible/DEPLOY.md`. Inventories and generated configs
  stay under ignored `ops/local/`. Existing proxy/VPN services are not auto-adopted.
- Service provisioning: `task ops:services:prepare` installs the Compose plugin and initializes the API environment without overwriting existing configuration. `task ops:identity:deploy` requires a real root-only `/etc/tjuclaw-identity-smtp.env`; `task ops:newapi:deploy` manages the internal model gateway. Both use isolated databases and durable secrets. Keep database/admin ports private; NewAPI is an operations service, never a second product identity authority.
- NewAPI HTTPS origin: `task ops:newapi:origin:deploy` (pre-provisioned TLS PEM;
  dedicated HAProxy 8443, preserves existing 443 service). See `ops/ansible/SERVICES.md`.
- Local containers: `task compose:up`, `task compose:down`
- Local visual audit: `task audit:index`, `task audit:dev`, `task audit:test`
- Refresh local auth audit evidence: `task audit:auth` (real tests, then private import).
  Reference mappings and captures stay under ignored `private/audit/`, never in client assets.
- Verify audit UI against existing local evidence: `task audit:ui`.
- Product UI regression: `task ui:install` once, then `task ui:test`
- Task workspace regression: `task workspace:test` (mocked browser contract checks).
  Real task ownership/persistence checks also run with `task auth:test`.
- API task records use `TASK_DATA_DIR` (default `backend/data/` when run by Task).
  Keep runtime data out of Git and build inputs; the file store supports one API process.
- Real email auth regression: `task auth:test` (isolated Docker/Go/Chromium)
- Local identity services: `task auth:up`, `task auth:dev`, `task auth:down`
- Install local Git hooks: `pnpm git:setup`
- Check the Git index: `pnpm git:check`
- Test Git policy: `pnpm test:git`

## Git and Versioning

- Follow `CONTRIBUTING.md`; root `package.json#version` is the repository version.
- Commit subjects must use `EMOJI [vVERSION] type(scope): summary`.
  The emoji must match the type and VERSION must match the staged package.json.
- Long-lived branches: `release` is the production and direct rapid iteration branch
  (direct commits and deployments after CI); `dev` is retained as an integration branch
  without deleting it. Develop directly on `release` for fast iteration; version tags are optional. Commit subjects and
  package versions continue to follow `CONTRIBUTING.md`. Use explicit-path staging
  and never stage another agent's unfinished work or create a commit/tag/push without task authorization.
- Keep research, local context, credentials, and runtime state out of Git.
- Keep the GitLab project Private, never Internal or Public without explicit approval.
- Internal plans and archived Wiki material remain local even for a private remote.
  Do not force-add ignored files. Hooks are a guardrail, not a secret scanner.
- Private files must not be copied into `docs/content/docs/`, `docs/public/`,
  `frontend/src/` or any build input. Docker contexts use explicit allowlists.
  Historical internal Wiki material and UI references are archived under ignored
  `private/wiki-archive/`; never reintroduce them into build inputs.
- GitHub is the development authority. Push reviewed release/version tags one-way to
  the private GitLab competition mirror; never enable reverse mirroring concurrently.
- Client Actions own Web/Linux/Android/Windows builds and UI/workspace regressions.
  Integration Actions own pinned-component checks and real Compose/auth regressions.
  Do not rebuild native clients merely because the server changed.
- Public client CI has a package-scoped GitLab deploy token; its release-only
  production environment may hold an EdgeOne deployment token. Private component
  checkout uses separate read-only deploy keys; project API tokens stay in integration.
- Explicit manual workflows stage verified client packages, then publish GitLab
  Releases with checksums and a complete tracked-source snapshot. Preserve immutable
  version contents; validate source SHAs and passing CI before promotion.
- CI and release instructions: `ops/ci/README.md`. No deployment, Pages or signed
  production release is implied by packaging or by the development Release workflow.
- Each repository's package.json owns its version. Tauri reads the client metadata;
  integration locks component SHAs. Rust crate version is internal metadata.

## Instruction Management

- Manage all repository-wide agent instructions in this `AGENTS.md`.
- Do not add tool-specific rule files that duplicate this file.
- Preserve the generated Next.js agent-rules block below.
- Update this file whenever commands, layout, or project conventions change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
