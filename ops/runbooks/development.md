# Development and CI

## Toolchain

Install Node 24, pnpm 11.3.0, Task 3.49.1, Go 1.26,
Rust stable via rustup, and Docker with Compose v2 or newer.
Keep Node/pnpm/Task on PATH on all platforms.

```bash
rtk task doctor
rtk task setup
rtk task native:info
rtk task check
rtk task build
```

Linux Tauri prerequisites (Debian/Ubuntu): `build-essential`, `pkg-config`,
`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libssl-dev`, `librsvg2-dev`,
`libayatana-appindicator3-dev`, `patchelf`, `file` and `curl`.
Hosted Linux packages are built on Ubuntu 24.04; test installation on each
supported distribution before claiming compatibility with older systems.
Use Windows x64 with Visual Studio C++ Build Tools, the Windows SDK, WebView2,
Rust's MSVC host toolchain and NSIS for `task windows:build`.

## Android

Install JDK 17, Android command-line tools, SDK platform 36, build-tools
35.0.0 and 36.0.0, and NDK 27.2.12479018. The generated Gradle project also
requires build-tools 35.0.0. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`
in the developer environment; never commit absolute local paths.
Review and accept Android SDK licenses before local installation. Hosted runners
use their installed SDK license state. No local credential or license file is uploaded.
Task optionally loads paths from ignored `.env.toolchain.local`; see
`.env.toolchain.example`. It never loads the PAT-bearing `.env.local`.
Task prefers rustup under `CARGO_HOME/bin` or `~/.cargo/bin`.
Gradle/Java may need JVM proxy properties locally even when command-line tools
use `HTTP_PROXY`; never commit proxy credentials or local network addresses.
`android:init` generates files; install Rust targets explicitly first.

```bash
rtk task android:licenses
rtk task android:sdk
rtk task android:targets
rtk task android:init
rtk task android:build
```

The APK is debug-signed for arm64 test devices, with a `.debug` application ID.
There is no release-signing key or store publishing task. Debug keys differ
between clean runners, so upgrading between builds may require uninstalling the
previous test app. Back up valuable local data before uninstalling.
CI disables Rust development debug information and incremental compilation and
bounds Gradle heap, metaspace and workers to avoid the previous memory failures.

## GitHub Actions

GitHub-hosted Ubuntu and Windows runners execute the Task commands.
See [the CI guide](../ci/README.md) for jobs, source synchronization and acceptance.
No Kubernetes Runner, private toolchain registry or integration VM is required.
`scripts/ci-preflight.mjs` checks each job's required tools before dependency
installation. Frozen pnpm installs allow 600 seconds per fetch with network
concurrency four. Native and browser dependencies are installed only where needed.

The integration job pre-pulls the isolated test stack's images before starting
Playwright's server timeout. It runs real Kratos, PostgreSQL and captured mail,
then tears down the test stack even on failure. This check is mandatory.
Appearance and task workspace browser tests run serially within their job to
avoid sharing a frontend build directory concurrently.

Windows builds an unsigned NSIS installer and records source SHA and SHA-256
checksums. Building does not prove installation or login works on a real device.
Public workflow logs and artifacts follow GitHub repository visibility; no broad
`test-results/` upload, credentials, private audit evidence or signing keys belong
there. Build/check workflows do not deploy, publish Pages, push images or upload
 to stores. Separate manual workflows stage GitLab packages and publish a verified
 development Release; see the CI guide for credentials and immutable version checks.

## Repository Changes

The private root integration repository pins frontend, backend and CLI submodules.
Its pnpm workspace contains documentation under `docs/`; the frontend has its own
workspace and lockfile. Initialize submodules before `task setup`; setup installs
root and frontend dependencies separately.
Use `task web:dev` for the product and `task docs:dev` for documentation.
No Task command auto-commits, rewrites Git history, or deletes persistent data.
Shell examples use RTK; tasks invoke tools directly, so CI does not need RTK.
GitLab remains the private competition repository. Its old Runner jobs are
explicitly disabled while GitHub Actions owns execution.

## Local Visual Audit

`task audit:index` validates ignored local evidence, and `task audit:dev` opens
an audit-only Vite mode on loopback port 1421. Reference images, descriptions,
journey data and imported captures come from `private/audit/`, never public assets.
Do not expose this server through a public relay or upload its data as CI artifacts.
Each screen supports 390x844, 360x800, 768x1024 and 1440x900 captures. A capture
is evidence, not approval. Overlay inspection is not a numeric pixel-diff test.
`task audit:test` uses temporary fixtures and never edits real evidence.

## Acceptance

Local portable checks, builds and browser tests provide development evidence.
A valid workflow or successful local build does not prove a hosted run succeeded.
Record the exact source SHA and GitHub run URL after remote execution. Native
package production and device installation are separate acceptance steps.
Campus capabilities and Pi execution must be verified independently of CI.
