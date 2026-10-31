#!/bin/sh
# PreToolUse hook for Bash: runs a few read-only commands through the pinned rtk.
#
# Fail open. On any doubt or error this prints nothing and exits 0, so the
# command runs exactly as Claude wrote it. It never exits 2, which would block
# the call, and never returns a permission decision.
#
# Tool input is data. It arrives on stdin, is only compared with fixed patterns,
# and leaves through jq --arg. Nothing here evaluates it.

[ "${RTK_DISABLED:-}" != 1 ] || exit 0

export LC_ALL=C

# Keeps rtk from storing commands and output under ~/.local/share, from sending
# telemetry, and from telling the agent to run `rtk init -g`.
quiet='RTK_DB_PATH=/dev/null RTK_RECALL=0 RTK_SUPPRESS_HOOK_WARNING=1 RTK_TELEMETRY_DISABLED=1'
export RTK_DB_PATH=/dev/null RTK_RECALL=0 RTK_SUPPRESS_HOOK_WARNING=1 RTK_TELEMETRY_DISABLED=1

rtk=$HOME/.local/bin/rtk
[ -x "$rtk" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v timeout >/dev/null 2>&1 || exit 0

# $rtk goes into a shell command below, so it must not need quoting.
case "$rtk" in
  *[!A-Za-z0-9_./-]*) exit 0 ;;
esac

input=$(cat)

# Only in bypassPermissions. A rewritten command is no longer one of Claude
# Code's auto-approved read-only commands, so in any mode that can prompt, a
# rewrite would turn a silent `git status` into a prompt.
cmd=$(printf '%s' "$input" | jq -r '
  select(.tool_name == "Bash" and .permission_mode == "bypassPermissions")
  | .tool_input.command | strings' 2>/dev/null)
[ -n "$cmd" ] || exit 0

# One simple command only. This also keeps out `#`, which would comment out the
# rtk half of the command built below. Anything unusual stays raw.
case "$cmd" in
  *[!A-Za-z0-9_./:=,@%+^*?{}~\"\'\ -]*) exit 0 ;;
esac

# Quotes must pair up and be of one kind, or the two copies of the command below
# would not parse as two commands.
single=$(printf '%s' "$cmd" | tr -cd "'")
double=$(printf '%s' "$cmd" | tr -cd '"')
if [ -n "$single" ] && [ -n "$double" ]; then exit 0; fi
[ $(((${#single} + ${#double}) % 2)) -eq 0 ] || exit 0

# Raw by default: a command is listed here only after a fidelity test showed that
# its output keeps every fact or marks each cut. See docs/project-tools.md.
safe_flags=
case "$cmd" in
  'git status') ;;
  'grep '*) safe_flags=rRnEFiw ;;
  'rg '*) safe_flags=nNiFwS ;;
  *) exit 0 ;;
esac

if [ -n "$safe_flags" ]; then
  # Claude Code's worktree isolation guard refuses an rtk call with git among its
  # operands, so a search for "git" would fail where the raw command works.
  case "$cmd" in
    *[Gg][Ii][Tt]*) exit 0 ;;
  esac
  # Other flags change the output shape or read more than the arguments name.
  set -f
  for word in $cmd; do
    case "$word" in
      - | -*[!"$safe_flags"]* | \"-* | \'-*) exit 0 ;;
    esac
  done
  set +f
fi

[ "$(timeout 2 "$rtk" --version 2>/dev/null)" = 'rtk 1.1.0' ] || exit 0

# Let rtk decide. It keeps git raw inside .claude/worktrees, where the same guard
# would refuse `rtk git`. Accept only the plain prefix form it is known to return.
rewritten=$(printf '%s' "$input" |
  timeout 2 "$rtk" hook claude 2>/dev/null |
  jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)
[ "$rewritten" = "rtk $cmd" ] || exit 0

# Keep the original as a subcommand that never runs. Claude Code applies deny and
# ask rules to every subcommand, from every source, so a rule on the original
# still fires. A bare `rtk ...` would slip past those rules.
printf '%s' "$input" | jq -c \
  --arg command "true || $cmd; $quiet $rtk $cmd" \
  --arg note "rtk may have shortened this output. For the full output run: RTK_DISABLED=1 $cmd" \
  '{hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: (.tool_input + {command: $command}),
      additionalContext: $note}}' 2>/dev/null

exit 0
