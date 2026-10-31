# Sourced by the Trail hooks. Finds the pinned Trail install or ends the hook.
#
# This calls the pinned binary directly and never runs `trail init`, a
# session-start hook, or `trail mcp`: those reach Trail's self-heal, which writes
# to ~/.claude. Only `ask` and `build` run here, and neither reaches it.

[ "${TRAIL_NO_HOOKS:-}" != 1 ] || exit 0

root=${CLAUDE_PROJECT_DIR:-}
trail=$HOME/.local/share/trail-code/0.28.1/node_modules/.bin/trail
[ -n "$root" ] && [ -x "$trail" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v timeout >/dev/null 2>&1 || exit 0

# Telemetry, update checks, background fetches, session look-back, and the
# .ignore file that would put graft/ into ripgrep results all stay off.
export DO_NOT_TRACK=1 TRAIL_NO_FETCH=1 TRAIL_NO_LOOK_BACK=1 GRAFT_NO_IGNORE=1
