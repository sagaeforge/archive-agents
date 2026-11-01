#!/usr/bin/env bash
# Scans for secrets with a pinned gitleaks release: every commit including merge commits, every commit
# message, and the files at the tip. The download has to match the release's published SHA-256, so a
# swapped archive fails here instead of running.
#
# Usage: gitleaks.sh [<repository> <commit>]
#
# With no arguments this scans the whole repository that holds this script. The pre-push hook names the
# commit being pushed and runs that commit's copy of this script, so the rules are that commit's too,
# and the scan reads only what that commit can reach.
set -euo pipefail

VERSION="8.30.1"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
# Each canary is put together below, so the scan finds no secret in this file. These names stay free of
# words like "token", which would set off gitleaks' generic rule.
CANARY_UUID="00000000-0000-4000-8000-000000000000"
CANARY_TAIL="aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6"

here=$(cd "$(dirname "$0")" && pwd)
repo=${1:-$(git -C "$here" rev-parse --show-toplevel)}
revisions=${2:---all}
tip=${2:-HEAD}

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
options=(--config "$here/../../.gitleaks.toml" --no-banner --redact --verbose)

# A rule that stopped firing would look just like a clean history, so each kind has to fire first.
must_find() {
  if "$work/gitleaks" stdin "${options[@]}" >/dev/null 2>&1; then
    echo "gitleaks missed the canary $1, so a clean result would mean nothing." >&2
    exit 1
  fi
}
printf '%s=%s\n' 'ci@pve!canary' "$CANARY_UUID" | must_find "PVE token"
printf '%s: %s\n' 'value' "$CANARY_UUID" | must_find "pveum output"
printf '%s%s\n' 'ghp_' "$CANARY_TAIL" | must_find "default rule"

# -m is what shows a merge commit's own changes: git log -p prints no diff for one by default.
"$work/gitleaks" git "${options[@]}" --log-opts="$revisions --full-history -m" "$repo"

# git log -p leaves these two out: a commit message, and a file git calls binary.
git -C "$repo" log --format=%B "$revisions" | "$work/gitleaks" stdin "${options[@]}"

mkdir "$work/tree"
git -C "$repo" archive "$tip" | tar -x -C "$work/tree"
"$work/gitleaks" dir "${options[@]}" "$work/tree"
