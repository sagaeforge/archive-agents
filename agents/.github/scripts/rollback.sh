#!/usr/bin/env bash
# Moves stable back to an earlier commit that passed CI. This is the one forced move of stable, for
# when reverting on main and letting CI promote is not an option. See docs/stable-gate.md.
set -euo pipefail

sha=${1:-}

# The value comes from a form, so it stays out of the log: the runner reads ::commands:: in output.
if [[ ! $sha =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Expected a full 40-character commit SHA."
  exit 1
fi

refs=$(git ls-remote origin refs/heads/main refs/heads/stable)
main=$(awk '$2 == "refs/heads/main" { print $1 }' <<<"$refs")
stable=$(awk '$2 == "refs/heads/stable" { print $1 }' <<<"$refs")

if [[ -z $stable ]]; then
  echo "::error::stable does not exist, and rollback never creates it. See docs/stable-gate.md."
  exit 1
fi

if [[ $sha == "$stable" ]]; then
  echo "::notice::stable is already at $sha."
  exit 0
fi

git fetch --quiet origin refs/heads/main refs/heads/stable

# Force must only ever go backward, or this would be a way to skip the gate.
if ! git merge-base --is-ancestor "$sha" "$stable"; then
  echo "::error::$sha is not an earlier commit of stable."
  exit 1
fi

# Off main, every later promotion would stop being a fast-forward.
if ! git merge-base --is-ancestor "$sha" "$main"; then
  echo "::error::$sha is not on main."
  exit 1
fi

# History holds commits that failed CI, and that is no place to send machines back to. Numeric
# comparison on purpose: empty output counts as zero here, so a confused gh cannot wave one through.
passed=$(gh run list --workflow ci.yml --commit "$sha" --status success --json databaseId --jq length)
if [[ $passed -lt 1 ]]; then
  echo "::error::CI never passed on $sha."
  exit 1
fi

if ! git diff --quiet "$stable" "$sha" -- .github/workflows; then
  echo "::warning::This range changes .github/workflows, and GitHub may refuse GITHUB_TOKEN for that. If the push fails, see docs/stable-gate.md."
fi

# The lease loses to anything that moved stable since it was read above.
git push --force-with-lease="refs/heads/stable:$stable" origin "$sha:refs/heads/stable"
echo "::notice::stable moved from $stable to $sha. Revert the cause on main before the next push."
