# TJUClaw self-hosted Actions runner image.
#
# The runner pods start cold for every job. Baking the toolchains CI uses into
# the image (and into the Actions tool cache that setup-node/setup-go consult)
# saves several minutes per job. Versions must match CI:
#   Node  -> .github/actions/setup (setup-node '24' resolves to this version)
#   Go    -> backend/go.mod
#   Task  -> .github/actions/setup
#   Playwright -> frontend/pnpm-lock.yaml (@playwright/test)
# The base is pinned to the runner digest the pool already uses.
FROM ghcr.io/actions/actions-runner@sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4

ARG NODE_VERSION=24.21.0
ARG GO_VERSION=1.27.0
ARG TASK_VERSION=3.49.1
ARG UV_VERSION=0.12.19
ARG PLAYWRIGHT_VERSION=1.63.0

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# System packages the CI jobs install on every run.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils \
      docker-compose-v2 ffmpeg gcc iproute2 libc6-dev poppler-utils webp python3 python3-pil \
 && rm -rf /var/lib/apt/lists/*

# Node and Go laid out exactly as actions/setup-node and actions/setup-go cache
# them, so both resolve from the tool cache without downloading.
RUN set -eux; \
    mkdir -p "$RUNNER_TOOL_CACHE/node/$NODE_VERSION/x64" "$RUNNER_TOOL_CACHE/go/$GO_VERSION/x64"; \
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
      | tar -xJ --strip-components=1 -C "$RUNNER_TOOL_CACHE/node/$NODE_VERSION/x64"; \
    touch "$RUNNER_TOOL_CACHE/node/$NODE_VERSION/x64.complete"; \
    curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" \
      | tar -xz --strip-components=1 -C "$RUNNER_TOOL_CACHE/go/$GO_VERSION/x64"; \
    touch "$RUNNER_TOOL_CACHE/go/$GO_VERSION/x64.complete"

# Task and uv as plain binaries on PATH.
RUN set -eux; \
    curl -fsSL "https://github.com/go-task/task/releases/download/v$TASK_VERSION/task_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin task; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/bin uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx; \
    task --version; uv --version

# Chromium and its system libraries for the Playwright suites.
RUN set -eux; \
    PATH="$RUNNER_TOOL_CACHE/node/$NODE_VERSION/x64/bin:$PATH" \
      npx --yes "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm

RUN chown -R runner:docker "$RUNNER_TOOL_CACHE" "$PLAYWRIGHT_BROWSERS_PATH"
USER runner
