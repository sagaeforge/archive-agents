# Sourced by the Trail hook. Finds the pinned Trail install or ends the hook.
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

# Trail takes a folder with no .git and two repos under it for a workspace, and `build`
# then builds each child from that child's parse memo, past --no-reuse. See
# trail-context.sh. A checkout of this repo always has .git.
[ -e "$root/.git" ] || exit 0

# Each of these puts a checkout on Trail's own path, and these are all of them in this
# version: mapDirFor and repoWiredForTrail. There `ask` makes .trail/, moves the map into
# it, starts detached children, and a missing map gets a detached build that replays the
# parse memo. Trail has no switch for any of it, so the hook stands down. `trail init`
# leaves these behind. See docs/project-tools.md.
[ ! -e "$root/.trail" ] || exit 0
[ ! -e "$root/.claude/helpers/trail-hooks.cjs" ] || exit 0
[ ! -e "$root/.claude/skills/trail/SKILL.md" ] || exit 0
case $(cat "$root/.claude/settings.json" 2>/dev/null) in
  *trail-hooks.cjs* | */.trail/hook.cjs*) exit 0 ;;
esac

# Project files must not choose where Trail goes, and nothing in this repo needs these,
# so the hook stands down rather than filter them. workspace.json lists child repos by
# any path, and `ask` rebuilds each one in place and answers from it. A link at or under
# the map sends Trail's writes wherever it points, and at graft/ itself its card cleanup
# too. find fails closed: if it cannot look, Trail does not run.
[ ! -e "$root/graft/workspace.json" ] || exit 0
for dir in graft .graft; do
  [ ! -L "$root/$dir" ] || exit 0
  [ -e "$root/$dir" ] || continue
  links=$(find "$root/$dir" -type l 2>/dev/null) && [ -z "$links" ] || exit 0
done

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
# git, so these are the settings Claude Code forces on its own git calls. GRAFT_DIR can
# still arrive from the env block of a settings file, and the map belongs in graft/.
export DOTENV_PATH=/dev/null
unset GRAFT_DIR
export GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false \
  GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null

# The third way that config runs a command. With a promisor remote, reading a .gitignore
# that exists only in the index fetches its blob, and the fetch runs remote.*.uploadpack
# or an ext:: url. Trail's `ls-files` does that read. This stops the fetch, from git 2.45.
export GIT_NO_LAZY_FETCH=1

# Two more files Trail follows out of the project. A .git file names any checkout, and
# `ask` copies that checkout's map in when there is none here. A .gitignore can be a link,
# and `build` appends to whatever it points at. Hooks never run --deep, so a copied map
# saves only a parse, and .gitignore already lists the map in every branch that has this
# hook.
export GRAFT_NO_SEED=1 GRAFT_NO_GITIGNORE=1
