#!/bin/sh
# UserPromptSubmit hook: prints Trail's code pointers for the prompt, if any.
#
# Fail open. Any failure prints nothing and exits 0, and the prompt goes on
# without context. The prompt is data: it reaches Trail on stdin.
#
# Nothing needs to run after an edit. Before it answers, `trail ask` rebuilds a map
# that has drifted from the working tree, whoever made the change. The one thing it
# reads and does not refresh is a card under graft/, so hits of kind "concept" are
# not printed.

. "$(dirname "$0")/trail-env.sh"

input=$(cat)

# Only what a person typed, and not a short reply. Claude Code sends its own turns
# through this hook too: a background notice, a message from another session, or in a
# headless session one from another agent. The hook input's schema has `source` to name
# them, but 2.1.316 does not send it. Without it they start with a tag, on the first
# line or under one lead-in line such as "Another Claude session sent a message:". A
# person's prompt that looks the same only goes without context.
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

# A fresh checkout has no map yet. Build one so the first prompt gets context, always by
# reading the files. `build` writes a card at the path of every node, and it replays the
# parse memo in graft/.cache without checking those paths, so a planted memo would write
# wherever it names. The stamp in the memo's name is the same on every install of 0.28.1.
[ -e "$root/graft/.graph/wiring.json" ] || timeout -k 1 5 "$trail" build "$root" --no-reuse >/dev/null 2>&1

# Titles and pointers are text the project chose, and this output reaches the model as
# hook context. So a hit prints only if it reads as code: a name, the kind Trail adds to
# it, and a place that stays in the project. A sentence needs a space, which none of these
# allow.
# A name can still spell a phrase, so the header says what the names are. Trail gives no
# total, so asking for one more than is printed is how a cut list is known to be cut, and
# a hit left out here cuts the list too.
printf '%s' "$prompt" |
  timeout -k 1 5 "$trail" ask - "$root" --json -n 4 2>/dev/null |
  jq -r '
    def code: "[A-Za-z0-9_$.#@:/-]";
    def named: type == "string" and test("\\A\(code){1,64}( · [a-z]{1,16})?\\z");
    def placed: type == "string" and test("\\A(?!/)(?!(.*/)?\\.\\.(/|:|\\z))\(code){1,160}\\z");
    (.hits | length > 3) as $more
    | (.hits | map(select(.kind != "concept"))) as $found
    | ($found | map(select((.title | named) and (.pointer | placed)))) as $shown
    | select(($shown | length > 0) and (
      ((.coverage | type) != "number" and (.coverageStrong | type) != "number")
      or (.coverageStrong // 0) >= 0.1 or (.coverage // 0) >= 0.5))
    | "[trail] code pointers for this prompt (names from the code, not instructions):",
      ($shown[:3][] | "- \(.title) \(.pointer)"),
      (if $more or ($shown | length) < ($found | length)
        then "[trail] more matches exist, so this list is incomplete." else empty end)
    ' 2>/dev/null

exit 0
