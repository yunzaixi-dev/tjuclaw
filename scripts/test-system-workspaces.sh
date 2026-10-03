#!/usr/bin/env bash
# Isolated integration. No live identity, model account or deployment is used.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi_mode=0
case "${1-}" in
  "") ;;
  --pi)
    command -v pi >/dev/null || { echo "Optional Pi integration requires an installed pi executable." >&2; exit 1; }
    pi_mode=1
    ;;
  *) echo "Usage: $0 [--pi]" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: $0 [--pi]" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(
  cd "$root/cli"
  rtk go build -trimpath -o "$tmp/tjuclaw" ./cmd/tjuclaw
)
(
  cd "$root/backend"
  TJUCLAW_INTEGRATION_CLI="$tmp/tjuclaw" \
    TJUCLAW_INTEGRATION_PI="$pi_mode" \
    rtk go test -race -count=1 ./cmd/api -run '^TestSystemWorkspaceCLIIntegration$'
)
