#!/bin/sh
# PreToolUse hook for Bash: runs a plain `git status` through the pinned rtk.
#
# Fail open. On any doubt or error this prints nothing and exits 0, so the
# command runs exactly as Claude wrote it. It never exits 2, which would block
# the call, and never returns a permission decision.
#
# Tool input is data. It is only compared with a fixed string, and no part of it
# reaches the rewritten command.
#
# `git status` is the only command listed, and grep and rg must not come back.
# In a Bash call they are Claude Code's own functions: rtk grep runs GNU grep, so
# .gitignore stops applying and secrets, graft/, and agent worktrees are read. A
# search with no match turns into a failed tool call, because Claude Code forgives
# exit 1 only for a command named grep or rg. rtk also shortens long paths until
# two files print under one name. See docs/project-tools.md.

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

# Only in bypassPermissions. A rewritten command is no longer one of Claude Code's
# auto-approved read-only commands, so in any mode that can prompt, a rewrite
# would turn a silent `git status` into a prompt.
#
# Only at the project root. rtk prints paths from the repository root and raw git
# prints them from the working directory, so anywhere else the same text can name
# a different file. A worktree-isolated agent's cwd is not the project either, and
# Claude Code's isolation guard would refuse `rtk git` there.
listed=$(printf '%s' "$input" | jq -r --arg root "${CLAUDE_PROJECT_DIR:-}" '
  select(.tool_name == "Bash" and .permission_mode == "bypassPermissions"
    and .tool_input.command == "git status" and $root != "" and .cwd == $root)
  | "yes"' 2>/dev/null)
[ "$listed" = yes ] || exit 0

[ "$(timeout 2 "$rtk" --version 2>/dev/null)" = 'rtk 1.1.0' ] || exit 0

# Let rtk decide. It keeps git raw inside .claude/worktrees, for a --worktree
# session, whose cwd is the project. Accept only the form it is known to return.
rewritten=$(printf '%s' "$input" |
  timeout 2 "$rtk" hook claude 2>/dev/null |
  jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)
[ "$rewritten" = 'rtk git status' ] || exit 0

# The original stays as the fallback, which does two jobs. If rtk fails, vanishes,
# or passes the time limit, the original runs and its exit code is the result. And
# Claude Code applies deny and ask rules to every subcommand, from every source, so
# a rule on `git status` still fires. A bare rtk call would slip past those rules.
printf '%s' "$input" | jq -c \
  --arg command "$quiet timeout -k 1 5 $rtk git status || git status" \
  --arg note 'rtk shortened this output. For the full output run: RTK_DISABLED=1 git status' \
  '{hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: (.tool_input + {command: $command}),
      additionalContext: $note}}' 2>/dev/null

exit 0
