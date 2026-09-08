# GitHub Actions CI

The source repository is `https://github.com/yunzaixi-dev/tjuclaw`.
Hosted Ubuntu 24.04 and Windows 2022 runners execute the existing Task commands.
No self-hosted Runner, Kubernetes cluster, private build image or integration VM
is required. Workflow configuration alone does not establish successful execution;
use the actual run URL, commit SHA and produced artifacts for acceptance.

## Checks and builds

`.github/workflows/ci.yml` runs on pushes, pull requests and manual dispatch:

| Job | Acceptance |
| --- | --- |
| Portable checks | `task check`, all Go packages with the race detector |
| Browser | Appearance and task workspace browser regressions, run serially |
| Integration | Compose configuration/context checks and real Kratos/email/task ownership regression |
| Web/docs/API/CLI | Build each component; retain Web, API and CLI artifacts |
| Linux | Build a Debian package |
| Android | Build a debug arm64 APK |

`.github/workflows/windows.yml` uses the same triggers to build an unsigned NSIS
installer, recording its SHA-256 and source SHA. Native artifacts are test builds;
build success does not establish installation, device compatibility or production
signing. CI does not deploy, publish releases/Pages, or upload to application stores.

Actions are pinned to commit SHAs. Workflow tokens default to read-only.
Public repository logs and artifacts are public: upload only named build outputs,
never a broad `test-results/` directory, private audit evidence, environment files,
credentials or signing keys. Artifacts expire after seven days. Fork PR builds use
no campus credentials or status-reporting secret and never use `pull_request_target`.

Node 24, pnpm from `packageManager`, Go from `backend/go.mod`, and Task 3.49.1 are
installed by the workflows. Platform preflight runs before frozen dependency
installation. Android uses Java 17, SDK 36, build-tools 35/36 and NDK 27.2.12479018.
The integration job downloads its Docker images before starting the Playwright
server timeout and always tears down its isolated Compose stack.

## GitLab competition repository

GitLab remains the private upstream competition repository. `.gitlab-ci.yml`
disables the retired Runner jobs; it does not report a successful test pipeline.
GitLab push mirroring runs in the GitLab service itself, without a CI Runner:

```text
GitLab protected branch push
  -> GitLab SSH push mirror (same commit SHA)
  -> GitHub push event
  -> hosted CI + Windows workflows
  -> trusted status reporter
  -> GitLab commit status linking to the GitHub run
```

Use a repository-scoped GitHub write deploy key for the mirror, with GitLab's
mirror-generated SSH key and GitHub host keys verified from its HTTPS metadata
API. Do not distribute a personal GitHub administrator token. Configure only
protected branches and `keep_divergent_refs=true`; do not force-overwrite a
divergent GitHub branch. The source of truth is GitLab. Avoid editing mirrored
branches directly on GitHub; merge reviewed changes upstream, then mirror them.
Only protected branches are mirrored: an unprotected GitLab topic branch or an
MR merge-result ref does not automatically get a GitHub run. GitHub PR tests do
not imply GitLab MR merge-result coverage. Tags should also be reviewed before
publication because branch filtering is not a general private-ref filter.

A mirror needs outbound SSH access from GitLab to GitHub (the configured SSH
endpoint can use port 443). After setup or a new push, inspect mirror status and
compare branch SHAs on both services. The mirror is asynchronous; configuring it
is not proof of a successful transfer. No GitHub-to-GitLab code mirror is created,
so status callbacks cannot create a source synchronization loop.

## Status reporting

The separate `.github/workflows/gitlab-status.yml` workflow receives CI/Windows
lifecycle events. It runs trusted default-branch code only for pushes to `main`
from this repository. It does not execute PR code, restore untrusted caches or
consume build artifacts. The reporter reads the current GitHub run state and
checks that the exact commit exists in GitLab before posting its status.
CI and Windows have separate status contexts; neither can overwrite the other.
Do not claim this alone provides a configured GitLab merge gate.

Repository configuration:

- Secret `GITLAB_STATUS_TOKEN`: project-scoped token with `api` scope. The current
  protected `main` policy requires Maintainer access to post pipeline status;
  a Developer token can read the commit but receives HTTP 403 when posting.
  `read_api` cannot write status. Never use a personal administrator token here.
- Variables `GITLAB_URL`, `GITLAB_PROJECT_ID`: approved GitLab endpoint/project.
- Variable `GITLAB_STATUS_ENABLED`: set to `true` after provisioning the secret.

Rotate the token before its expiration; callbacks failing or being disabled must
not be interpreted as a passing build. Keep provisioning records and credentials
in ignored local storage. Verify both a successful and a failed status mapping
with tests, then inspect actual remote callbacks on the matching source SHA.

## Local validation

```bash
rtk pnpm test:tooling
rtk task check
rtk git diff --check
```

Use `actionlint` on all workflows before pushing. Public-source review covers the
actual Git commits and history, not a copy of the dirty working directory.
Ignored research, local plans, dependencies, runtime data and generated native
projects must never be force-added or mirrored.
