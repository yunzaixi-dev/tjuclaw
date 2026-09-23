# Docs Knowledge Base

## OVERVIEW

Next.js 16 + Fumadocs static-export site. The root pnpm workspace contains Docs;
its pages and content are independent from the client deployment.

## WHERE TO LOOK

| Need | Location |
| --- | --- |
| Markdown source | `content/docs/**/*.md` |
| Navigation order | `content/docs/meta.json`, `content/docs/blog/meta.json` |
| Fumadocs loader | `src/lib/source.ts` |
| Shared route constants | `src/lib/shared.ts` |
| Page rendering | `src/app/docs/[[...slug]]/page.tsx` |
| MDX/Next config | `source.config.ts`, `next.config.mjs` |
| Site output routes | `src/app/llms*`, `src/app/og/` |

## CONVENTIONS

- Edit prose only under `content/docs`; update the relevant `meta.json` when a
  page or blog entry changes navigation.
- `content/docs/index.md` is the source for root `README.md` and `DESIGN.md`.
  Run `rtk task docs:sync` or `rtk task docs:check-sync` after homepage changes.
- Use existing source helpers and `/docs`, `/og/docs`, `/llms.mdx/docs` route
  constants instead of hardcoding derived URLs.
- Math content must follow the configured `remarkMath` and `rehypeKatex` pipeline.

## ANTI-PATTERNS

- Do not hand-edit root `README.md` or `DESIGN.md`; the generator overwrites them.
- Do not edit `.source`, `.next`, or `out`; they are generated/cache boundaries.
- Do not assume runtime Next server features: `next.config.mjs` uses `output: export`.
