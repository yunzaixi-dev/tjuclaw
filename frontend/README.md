# Client

React + Vite + Tailwind / shadcn-compatible components, shared by Web and Tauri 2.
`src/` is shared UI; `src-tauri/` contains the native host and its capability policy.
The product opens an email authentication entry with real Kratos browser flows.
Campus/agent services are not yet connected. The original appearance preview is
at `/preview/appearance`. See `UI.md` and root `DEVELOPMENT.md` for UI/API rules,
and `ops/auth/README.md` for local identity services. Browser authentication does
not yet implement Tauri's native session transport.
The separate `task audit:dev` mode provides local visual comparison tooling;
its private evidence dataset is not included in the normal client build.

The audit desk opens an email-login review with state selection, four viewport
sizes, light/dark captures, reference comparison and product interaction paths.
Run `task audit:auth` to run the isolated auth suite and import its evidence;
`task audit:auth:import` imports an already passing complete run. Local mappings
must exist in ignored `private/audit/auth-config.json`; screenshots and generated
manifests remain there, never in the client bundle. Missing references and
captures remain explicit gaps. The capture time and test scope are shown, and
injected HTTP errors are distinguished from real Kratos responses. OTP fields
are masked in audit captures. This does not certify native auth or production
email delivery. Do not run this alongside other tests that rebuild `frontend/dist`.
Use `task audit:ui` to check the audit desk itself at four responsive widths,
including comparison controls, image zoom, state navigation and missing evidence.

Run tasks from the repository root:

```bash
rtk task web:dev
rtk task desktop:dev
rtk task native:info
rtk task linux:build
rtk task windows:build
rtk task android:build
```

Windows builds run on Windows with MSVC, WebView2 and NSIS prerequisites.
Linux builds produce `.deb` on Linux; use a supported Debian/Ubuntu runner for
distributable packages rather than treating an Arch build as a portability test.
Android needs JDK 17+, SDK command-line tools, platform/build-tools, NDK and
Rust Android targets. See `ops/runbooks/development.md`.

Android Gradle projects are generated with `task android:init`, not committed.
Persistent Gradle/manifest changes must be applied by a reviewed source-controlled
configuration or patch before relying on regeneration. Debug APKs are installable
test builds, not release-signed packages; Windows installers are unsigned.

Root `package.json` supplies the UI and Tauri product version. Rust's `0.0.0`
crate version is internal, unpublished build metadata. Commit `Cargo.lock` and
the workspace `pnpm-lock.yaml`; ignore native targets, SDK state and signing keys.

`components.json` configures shadcn; add components when used rather than importing
an entire component catalogue. Native capabilities currently allow only app
version reads, not filesystem access or shell execution.
