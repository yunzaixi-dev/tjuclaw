# TJUClaw Project Instructions

Muse Code reads this file as the single source of truth for project rules.
Add or update repository-wide agent instructions here instead of duplicating
them in tool-specific files.

## Project

- Name: TJUClaw
- Documentation: Next.js 16 with Fumadocs.
- Package manager: pnpm.
- Primary content: `content/docs/`.
- Application source: `src/`.
- Product frontend: `frontend/`; backend: `backend/`; operations: `ops/`.
- The root Next.js application remains the Wiki. Do not move it while parallel
  work is in progress or treat it as the product frontend.
- Before architecture work, read local `CONTEXT.md` when available. Historical
  Wiki content is not authoritative for current private product decisions.
  Do not publish private decisions into the Wiki without explicit approval.

## Common Commands

- Development: `pnpm dev`
- Lint: `pnpm lint`
- Type check: `pnpm run types:check`
- Production build: `pnpm build`
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
- Private files must not be copied into `content/docs/` or `public/`.
  Historical internal Wiki material and UI references are archived under ignored
  `private/wiki-archive/`; never reintroduce them into build inputs.
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
