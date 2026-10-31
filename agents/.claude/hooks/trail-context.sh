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

# Same gate as Trail's own hook: skip short prompts and background notices.
prompt=$(jq -r '
  .prompt | strings
  | select(length >= 12 and (sub("^\\s+"; "") | startswith("<task-notification>") | not))
  ' 2>/dev/null)
[ -n "$prompt" ] || exit 0

# A fresh checkout has no map yet. Build one so the first prompt gets context.
[ -e "$root/graft/.graph/wiring.json" ] || timeout 5 "$trail" build "$root" >/dev/null 2>&1

printf '%s' "$prompt" |
  timeout 5 "$trail" ask - "$root" --json -n 3 2>/dev/null |
  jq -r '
    .hits |= map(select(.kind != "concept"))
    | select((.hits | length > 0) and (
      ((.coverage | type) != "number" and (.coverageStrong | type) != "number")
      or (.coverageStrong // 0) >= 0.1 or (.coverage // 0) >= 0.5))
    | "[trail] code pointers for this prompt:", (.hits[] | "- \(.title) \(.pointer)")
    ' 2>/dev/null

exit 0
