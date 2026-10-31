#!/bin/sh
# UserPromptSubmit hook: prints Trail's code pointers for the prompt, if any.
#
# Fail open. Any failure prints nothing and exits 0, and the prompt goes on
# without context. The prompt is data: it reaches Trail on stdin.
#
# Nothing needs to run after an edit. `trail ask` rebuilds a map that drifted from
# the working tree before it answers, whoever made the change, and it only answers
# from that map here: a card under graft/ is the one thing it reads that a query does
# not refresh, so kind "concept" stays out of the printed lines.

. "$(dirname "$0")/trail-env.sh"

input=$(cat)

# Only what a person typed, and not a short reply. Claude Code sends its own turns
# through this hook too: a background notice, or in a headless session a message from
# another agent. `source` will name them, but no version has sent it yet. Until then
# they start with a tag, on the first line or under one lead-in line such as "Another
# Claude session sent a message:". A person's prompt that looks the same only goes
# without context.
prompt=$(printf '%s' "$input" | jq -r '
  select((.source // "user") | . == "user" or . == "sdk")
  | .prompt | strings
  | select(length >= 12 and (test("\\A\\s*([^\\n]*\\n\\s*)?<[A-Za-z]") | not))
  ' 2>/dev/null)
[ -n "$prompt" ] || exit 0

# The map describes $root. After EnterWorktree the session works in another checkout
# while CLAUDE_PROJECT_DIR stays put, so these pointers would name lines the agent
# does not have. A folder of this checkout is fine, and git compares real paths.
cwd=$(printf '%s' "$input" | jq -r '.cwd | strings' 2>/dev/null)
if [ "$cwd" != "$root" ]; then
  [ -n "$cwd" ] || exit 0
  here=$(timeout -k 1 2 git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
  [ "$here" = "$(timeout -k 1 2 git -C "$root" rev-parse --show-toplevel 2>/dev/null)" ] || exit 0
fi

# A fresh checkout has no map yet. Build one so the first prompt gets context.
[ -e "$root/graft/.graph/wiring.json" ] || timeout 5 "$trail" build "$root" >/dev/null 2>&1

# Titles and pointers come from file names and code, and this output reaches the model
# as hook context, so each stays on its own line whatever bytes it holds. Trail gives no
# total, so asking for one more than is printed is how a cut list is known to be cut.
printf '%s' "$prompt" |
  timeout 5 "$trail" ask - "$root" --json -n 4 2>/dev/null |
  jq -r '
    def oneline: tostring | gsub("[\\p{C}\\p{Zl}\\p{Zp}]+"; " ");
    (.hits | length > 3) as $cut
    | .hits |= map(select(.kind != "concept"))
    | select((.hits | length > 0) and (
      ((.coverage | type) != "number" and (.coverageStrong | type) != "number")
      or (.coverageStrong // 0) >= 0.1 or (.coverage // 0) >= 0.5))
    | "[trail] code pointers for this prompt:",
      (.hits[:3][] | "- \(.title | oneline) \(.pointer | oneline)"),
      (if $cut then "[trail] more matches exist, so this list is incomplete." else empty end)
    ' 2>/dev/null

exit 0
