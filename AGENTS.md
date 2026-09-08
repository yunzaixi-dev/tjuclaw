# TJUClaw Project Instructions

Muse Code reads this file as the single source of truth for project rules.
Add or update repository-wide agent instructions here instead of duplicating
them in tool-specific files.

## Project

- Name: TJUClaw
- Documentation: Next.js 16 with Fumadocs.
- Package manager: pnpm.
- Documentation app: `docs/`; content: `docs/content/docs/`; source: `docs/src/`.
- Product frontend: `frontend/`; backend: `backend/`; operations: `ops/`.
- Slidev presentation: `presentation/`, with its own pnpm workspace and lockfile.
  Keep the deck's implementation status tied to real checks; exported PDFs stay
  under ignored `test-results/presentation/`.
- Product CLI instructions: `skills/tjucli/`; these must be explicitly loaded
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
- Documentation: `task docs:dev`
- Presentation: `task slides:install`, `task slides:dev`, `task slides:build`,
  `task slides:export` (requires Playwright Chromium).
- Campus CLI: `task cli:build`, `task cli:test`; binary: `backend/bin/tjucli`.
  It currently covers the public course-sharing provider only.
- Checks: `task check`
- Portable build: `task build`
- Native builds: `task linux:build`, `task windows:build`, `task android:build`
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
- Use short-lived topic branches and explicit-path staging. Never stage another
  agent's unfinished work or create a commit/tag/push without task authorization.
- Keep research, local context, credentials, and runtime state out of Git.
- Keep the GitLab project Private, never Internal or Public without explicit approval.
- Internal plans and archived Wiki material remain local even for a private remote.
  Do not force-add ignored files. Hooks are a guardrail, not a secret scanner.
- Private files must not be copied into `docs/content/docs/`, `docs/public/`,
  `frontend/src/` or any build input. Docker contexts use explicit allowlists.
  Historical internal Wiki material and UI references are archived under ignored
  `private/wiki-archive/`; never reintroduce them into build inputs.
- GitHub Actions uses hosted Ubuntu runners for checks, real Compose/auth tests,
  Web/docs/API/CLI and Linux/Android builds, plus a hosted Windows runner for NSIS.
  GitLab remains the private competition repository; its old Runner jobs are disabled.
- The user authorized public source on GitHub under `yunzaixi-dev`. Review the exact
  Git commits before publication; ignored research, credentials and runtime state
  remain local. Public workflow logs and artifacts must contain no private evidence.
- CI migration and synchronization instructions: `ops/ci/README.md`.
  Jobs validate their toolchain with `scripts/ci-preflight.mjs` before installation.
  Actions do not deploy, publish releases/Pages, or upload signed packages.
- Root package version also drives Tauri bundles; Cargo crate version is internal
  metadata, not an independently released product version.
- Shell commands in agent sessions must be prefixed with `rtk`; use
  `rtk proxy` when unfiltered output is required.

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
