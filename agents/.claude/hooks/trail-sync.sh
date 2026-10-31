#!/bin/sh
# PostToolUse hook for Write, Edit, and MultiEdit: refreshes Trail's code map.
#
# Fail open. Any failure leaves the map as it was and exits 0. This stays
# synchronous because an async hook is cancelled when a short session ends.

. "$(dirname "$0")/trail-env.sh"

file=$(jq -r '.tool_input.file_path | strings' 2>/dev/null)

# An isolated agent's worktree has its own files, so its edits cannot change this
# map. The same goes for anything outside the project.
case "$file" in
  "$root"/.claude/worktrees/*) exit 0 ;;
  "$root"/*) ;;
  *) exit 0 ;;
esac

timeout 10 "$trail" build "$root" >/dev/null 2>&1

exit 0
