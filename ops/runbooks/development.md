# Development and CI

## Toolchain

Install Node 24 LTS (>=22.12), pnpm 11.3.0, Task 3.49.1, Go 1.26,
Rust stable via rustup, and Docker with Compose v2 or newer.
Keep Node/pnpm/Task on PATH on all runners, including the Windows service account.

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
The native `.deb` build should run on the oldest supported distribution.
Use Windows x64 with Visual Studio C++ Build Tools, the Windows SDK, WebView2,
Rust's MSVC host toolchain and NSIS for `task windows:build`.

## Android

Install JDK 17 or newer (21 recommended), Android command-line tools, SDK platform
36, build-tools 36.0.0 and NDK 27.2.12479018. Set `JAVA_HOME`, `ANDROID_HOME` and
`NDK_HOME` in the developer/runner environment, never commit absolute local paths.
Review and accept Android SDK licenses interactively before CI provisioning.
Task optionally loads these paths from ignored `.env.toolchain.local`; see
`.env.toolchain.example`. It never loads the PAT-bearing `.env.local`.
Task prefers an existing rustup installation under `CARGO_HOME/bin` or
`~/.cargo/bin`; a separate system `cargo` may not see rustup's Android targets.
Gradle/Java may need JVM proxy properties in the local toolchain environment
even when command-line downloads already use `HTTP_PROXY`. Never commit proxy
credentials or local network addresses.
`android:init` only generates files; install targets explicitly first.

```bash
rtk task android:licenses
rtk task android:sdk
rtk task android:targets
rtk task android:init
rtk task android:build
```

The default APK is debug-signed for arm64 test devices. There is deliberately no
release-signing key or store publishing task. Debug keys differ between clean
runners, so cross-build upgrades may require uninstalling the previous test app.
Debug builds use the `.debug` application ID suffix to avoid replacing a release.
Do not do this to an app with valuable local data without backing it up.

## GitLab Runners

CI is enabled with project-private logs and Maintainer-only artifacts. Jobs run
automatically on branch pushes, tags and merge requests; branch pipelines are
suppressed when an MR pipeline already covers the branch.

Register project-dedicated shell runners with these tags:

| Tag | Host and installed tools | Jobs |
| --- | --- | --- |
| `tjuclaw-linux` | Debian/Ubuntu amd64, common tools, Tauri Linux dependencies | Checks, Web, docs, API, Linux |
| `tjuclaw-android` | Linux amd64, Node/pnpm/Task, rustup + Android targets, JDK/SDK/NDK | Android debug APK |
| `tjuclaw-windows` | Windows x64, Node/pnpm/Task, Rust MSVC, C++ SDK, WebView2, NSIS | Windows installer |

Tags may be overridden with the three `*_RUNNER_TAG` CI variables. The Linux and
Android tags can belong to one adequately provisioned isolated runner.
No runner means jobs remain pending; a valid CI file is not proof of a successful
pipeline. Shell runners execute repository code with their service account's
permissions: use disposable/dedicated hosts, no production credentials or mounts,
and no untrusted fork pipelines. Do not install them on production servers.

Do not put PATs, signing keys or internal deployment addresses into YAML.
The initial CI does not deploy, publish Pages, push images or upload to stores.
Artifacts expire after seven days. Registering runners and pushing the
configuration are separate steps from enabling project CI.

## Repository Changes

The root now orchestrates a pnpm workspace. The docs app moved intact into `docs/`.
Use `task web:dev` for the product; `task docs:dev` for documentation.
No task auto-commits, auto-pushes, rewrites Git history, or deletes persistent data.
Run shell examples through RTK; tasks invoke tools directly so CI needs Task,
not an additional RTK installation.

## Local Visual Audit

`task audit:index` validates the ignored local evidence dataset, and
`task audit:dev` opens the audit-only Vite mode on loopback port 1421.
Reference images, descriptions, journey data and imported PNG captures are read
from `private/audit/`, never from public assets. The normal client build contains
no reference dataset. Do not expose the audit server through a public relay.

Each screen supports independent 390x844, 360x800, 768x1024 and 1440x900 captures.
Import PNGs at the exact selected dimensions; imports persist locally and replace
the existing capture for that screen/viewport. A capture is evidence, not approval.
Overlay inspection preserves aspect ratio and is not a numeric pixel-diff test.
`task audit:test` uses isolated temporary fixtures and never edits real evidence.

## Bootstrap Verification

Verified locally on 2026-09-06: portable checks, Web/docs/API builds, Rust check,
Linux Debian packaging, arm64 Android debug APK packaging and APK signature
verification. Web was checked at desktop and mobile viewport sizes. The Linux
binary passed a brief headless startup check; Android has not been device-tested.
The Compose images built and passed HTTP smoke tests; the actual Web build context
contained only the approved inputs, with no private files or build caches.
After adding local audit tooling, the context allowlist check passed with 17 inputs.

Windows packaging still needs a Windows runner. GitLab accepted the CI YAML, but
no remote pipeline has run: the configuration has not been pushed and runners are not
registered. These checks validate the engineering scaffold, not campus features.
