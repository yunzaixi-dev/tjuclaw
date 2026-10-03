#!/usr/bin/env bash
# Real API/registry/library <-> compiled gateway/Broker, synthetic model.
# Optional --pi uses real Controller Service, installed Pi and temporary Git.
# No production configuration, model account, container or deployment is used.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi=""
features=""
case "${1-}" in
  "") ;;
  --pi|--pi-features)
    pi="$(command -v pi)" || { echo "Optional Pi integration requires an installed pi executable." >&2; exit 1; }
    pi="$(realpath "$pi")"
    if [[ "$1" == "--pi-features" ]]; then features="1"; fi
    ;;
  *) echo "Usage: $0 [--pi|--pi-features]" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: $0 [--pi|--pi-features]" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(
  cd "$root/sandbox"
  rtk go test -c -race -o "$tmp/gateway-tests" ./internal/gateway
)
(
  cd "$root/backend"
  TJUCLAW_INTEGRATION_CLOUD_GATEWAY_TEST="$tmp/gateway-tests" \
    TJUCLAW_INTEGRATION_CLOUD_PI="$pi" \
    TJUCLAW_INTEGRATION_CLOUD_PI_FEATURES="$features" \
    rtk go test -race -count=1 ./cmd/api -run '^TestIsolatedCloudCompositionWithCompiledGateway$'
)
