#!/usr/bin/env bash
# Scans every commit for secrets with a pinned gitleaks release. The download has to match the
# release's published SHA-256, so a swapped archive fails here instead of running.
set -euo pipefail

VERSION="8.30.1"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

# A shallow clone would pass after reading only its newest commit.
if [[ $(git -C "$repo" rev-parse --is-shallow-repository) == true ]]; then
  echo "This clone is shallow, so the scan would miss history. Fetch with fetch-depth: 0." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$ARCHIVE" \
  "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/$ARCHIVE"
printf '%s  %s\n' "$SHA256" "$work/$ARCHIVE" | sha256sum --check --strict --quiet -
tar -xzf "$work/$ARCHIVE" -C "$work" gitleaks

# --redact keeps a finding's value out of the Actions log, which GitHub stores.
options=(--config "$repo/.gitleaks.toml" --no-banner --redact --verbose)

# A rule that stopped firing would look just like a clean history, so make it fire first. The two
# halves stay apart here because the scan below reads this file too.
if printf '%s=%s\n' 'ci@pve!canary' '00000000-0000-4000-8000-000000000000' |
  "$work/gitleaks" stdin "${options[@]}" >/dev/null 2>&1; then
  echo "gitleaks missed the canary PVE token, so a clean result would mean nothing." >&2
  exit 1
fi

"$work/gitleaks" git "${options[@]}" "$repo"
