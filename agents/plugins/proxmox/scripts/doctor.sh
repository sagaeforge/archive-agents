#!/usr/bin/env bash
# Checks this machine's proxmox plugin and changes nothing. doctor-checks.mjs lists what it looks at.
# Exit codes: 0 healthy, 1 warnings, 2 failures. --json prints the report as JSON.
#
# Without a Node that can run doctor.mjs, the first check gets its answer here, in the same form
# and with the same exit code.
set -euo pipefail

# Resolved first, so that a link to this script finds its neighbours.
SCRIPTS="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
MIN_NODE_MAJOR=26 # engines in package.json, which a test holds this to.
ACTION="Install Node 26 or newer with npm, on the PATH Claude Code starts with."

version=$(node --version 2>/dev/null) || version=""
major=${version#v}
major=${major%%.*}

if [[ $major =~ ^[0-9]+$ ]] && ((major >= MIN_NODE_MAJOR)); then
  # Node's own exit code for a script it cannot load is 1, which would read as a mere warning.
  if ! node --check "$SCRIPTS/doctor.mjs" 2>/dev/null; then
    echo "doctor: cannot load $SCRIPTS/doctor.mjs. Reinstall the plugin." >&2
    exit 2
  fi
  exec node "$SCRIPTS/doctor.mjs" "$@"
fi

if [[ -n $major && $major =~ ^[0-9]+$ ]]; then
  summary="node $major is older than the plugin's minimum, Node $MIN_NODE_MAJOR."
else
  summary="node is not on PATH, or does not run."
fi

for arg in "$@"; do
  if [[ $arg == --json ]]; then
    printf '{"status":"fail","exitCode":2,"checks":[{"id":1,"name":"toolchain","title":"Node and npm","status":"fail","summary":"%s","action":"%s"}]}\n' "$summary" "$ACTION"
    exit 2
  fi
done

printf ' 1  fail  Node and npm  %s\n              -> %s\n\nThe other checks need Node. Exit code 2.\n' "$summary" "$ACTION"
exit 2
