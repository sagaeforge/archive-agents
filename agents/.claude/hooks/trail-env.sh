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

# A checkout with .trail/ is on Trail's own path: `ask` starts detached children and
# the map moves out of graft/. Trail has no switch for either, so the hooks stand
# down. See docs/project-tools.md.
[ ! -e "$root/.trail" ] || exit 0

# Telemetry, update checks, background fetches, session look-back, and the
# .ignore file that would put graft/ into ripgrep results all stay off.
export DO_NOT_TRACK=1 TRAIL_NO_FETCH=1 TRAIL_NO_LOOK_BACK=1 GRAFT_NO_IGNORE=1

# A Trail home that cannot exist. With notes for this repo in ~/.trail, `ask` records
# the repo there and starts the detached _trail-branches, and for a connected
# workspace also _trail-sync. Here it finds no notes and no connection, and nothing
# can be written.
export TRAIL_HOME=/dev/null/trail

# Project files stay data. Trail loads <cwd>/.env and its git children inherit the
# result, so one plain file could run a command through core.fsmonitor or send the
# map into ~/.claude with GRAFT_DIR. The repo's own git config can reach the same
# git, so these are the settings Claude Code forces on its own git calls.
export DOTENV_PATH=/dev/null
export GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false \
  GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null
