#!/usr/bin/env bash
# Moves stable to the commit CI just passed. Machines follow stable, so this only ever fast-forwards
# it: there is no force here, and it never creates the branch. Creating stable is the owner's step
# in docs/stable-gate.md.
set -euo pipefail

sha=${1:?usage: promote.sh <commit sha>}

refs=$(git ls-remote origin refs/heads/main refs/heads/stable)
main=$(awk '$2 == "refs/heads/main" { print $1 }' <<<"$refs")
stable=$(awk '$2 == "refs/heads/stable" { print $1 }' <<<"$refs")

if [[ -z $stable ]]; then
  echo "::error::stable does not exist, and promote never creates it. See docs/stable-gate.md."
  exit 1
fi

# Only the tip of main moves stable. Re-running an older run must not bring back a commit that was
# reverted since, and the run for the tip decides anyway.
if [[ $sha != "$main" ]]; then
  echo "::notice::main is at $main now, so its own run decides. Leaving stable alone."
  exit 0
fi

git fetch --quiet origin refs/heads/stable

if git merge-base --is-ancestor "$sha" "$stable"; then
  echo "::notice::stable already contains $sha."
  exit 0
fi

if ! git diff --quiet "$stable" "$sha" -- .github/workflows; then
  echo "::warning::This range changes .github/workflows, and GitHub may refuse GITHUB_TOKEN for that. If the push fails, see docs/stable-gate.md."
fi

# Without force, both git and GitHub refuse anything but a fast-forward.
git push origin "$sha:refs/heads/stable"
