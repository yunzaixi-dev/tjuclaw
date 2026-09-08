# Client UI Foundation

## Component Ownership

Use the shadcn source-owned component pattern, Radix primitives for complex
interaction, Tailwind CSS 4 for utilities, and Lucide React for icons.
Our `Button` and `Dialog` are deliberately styled local implementations, not
unmodified shadcn registry output. They live in `src/components/ui/`.

Do not mix a second styled component system into the product. Add primitives only
when a real screen needs them. Native HTML remains preferable for simple controls:
appearance choices use labelled radio inputs, including native arrow-key behavior.
Internationalization is not installed; current UI copy is Chinese.

## Visual Contract

The product uses a restrained, neutral interface with generous spacing and rounded
surfaces. Use color for actions and state, not decoration. Mobile and desktop share
the same tokens and interaction semantics; responsive layout can differ.

| Concern | Source of truth / rule |
| --- | --- |
| Colors | Semantic CSS variables in `src/product.css`; light and dark values use OKLCH |
| Theme | `data-theme="light|dark"` on the document root |
| Accent | `data-accent="mono|blue"` on the document root |
| Text | Foreground and muted-foreground tokens; readable contrast in both themes |
| Typography | Native-first sans stack; 14-16px controls, 20-24px settings titles |
| Geometry | 16px choice radius, 40px panel radius, circular icon buttons |
| Touch | Interactive buttons at least 44x44px; radio tiles exceed this |
| Icons | Lucide, consistent stroke weight; CSS only for simple geometric swatches |
| Layering | Named `--z-overlay` and `--z-dialog` tokens, portal-based dialogs |
| Motion | 160-200ms state transitions; respect reduced motion |

Use `Button` variants `solid`, `ghost`, `floating`, and sizes `default`, `icon`.
Icon-only buttons need an accessible name. Dialogs need a title, description,
keyboard escape, focus containment and focus restoration to their actual opener.
Never remove focus indicators from interactive elements to improve screenshots.
Compound search controls put their focus ring on the rounded container using
`:focus-within`, replacing the input outline without hiding keyboard focus.

Shared native scrollbar styling lives in `src/scrollbars.css`: transparent tracks,
thin rounded thumbs, theme-aware contrast, and no arrow buttons. Keep native
wheel, touch, keyboard and drag behavior; do not add a JavaScript scroll engine or
hide scrollbars. Forced-colors mode restores browser styling. Rounded dialogs
inset their scrollbar track to keep it away from the corners.

## Appearance State

`src/lib/appearance.ts` owns preferences. Components use `useAppearance()` and
`setAppearance()` rather than writing attributes or storage themselves.

- Modes: `system`, `light`, `dark`; default `system`.
- Accents: `mono`, `blue`; default `mono`.
- Store only these preferences at `tjuclaw.appearance.v1`, never credentials.
- In system mode, subscribe to OS color-scheme changes.
- Explicit mode overrides the OS setting. Storage events synchronize other tabs.
- Validate stored values. Malformed values fall back to defaults.
- Blocked storage keeps in-memory controls usable and shows an honest notice.
- Apply theme attributes before rendering product content. Do not require inline
  script permissions in the native shell or weaken its CSP for theming.
- Set CSS `color-scheme` and the browser theme-color alongside the resolved theme.
- Preference persistence is per browser/WebView profile, not account/cloud sync.

Tailwind's `dark:` variant follows the same data attribute. Do not add a second
theme provider, per-component dark-mode booleans, or a next-themes dependency.

## Preview and Verification

`src/auth.tsx` owns the email authentication pages. `src/product.tsx` remains at
`/preview/appearance` and opens the appearance panel so its foundation can be
reviewed independently. The conversation and file preview are labelled demo
content, not an Agent integration. Closing the panel exposes the sample list.

Auth inputs reuse the compound rounded focus treatment. OTP entry is a single
labelled native input with numeric input mode and one-time-code autocomplete,
not six independently focused boxes. Pending, expired, error and success states
are explicit; a resend countdown is not a server-side security boundary.

Run `task ui:install` once, then `task ui:test`. Tests build the production client
and start an isolated preview on port 1422, without reusing a developer server.
They exercise themes, persistence, cross-tab updates, storage denial, keyboard
navigation, focus restoration, sample interactions, rounded search focus,
forced-colors focus, native scrolling and eight appearance captures:
360x800, 390x844, 768x1024 and 1440x900, each in light and dark.

Artifacts remain in ignored `test-results/ui/`. Screenshots are current-render
evidence, not an automatic pixel-match score or a substitute for visual review.
Native Windows/Android/Linux behavior still requires testing on those clients.

The audit app and product app are separate lazy entry points. Private reference
images, descriptions and research never enter this directory or a normal build.

## Task Workspace Surface

`src/workspace.tsx` owns the authenticated task workspace screen mounted at `/workspace`.
It implements durable task goal capture and viewing:
- Lists tasks newest first and supports selecting a task to inspect its prompt and metadata.
- Creates new task goals via `createTask()` with instant draft update.
- Clearly indicates status as `已保存 (draft)`.
- Explicitly clarifies that backend execution and model planning are not connected.
- Does not expose fake progress, completion checkboxes, cancellation controls, or fabricated execution results.
- Resets in-memory task state on sign-out, session loss (401), or user identity switch.
- Integrates with shared semantic tokens in `src/product.css` and appearance switching.
