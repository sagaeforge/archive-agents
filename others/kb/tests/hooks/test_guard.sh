#!/bin/bash
. "$(dirname "$0")/common.sh"
for c in "git status" "git log -n 1" "ls -la" "rtk git status"; do
  out=$(run_guard bypassPermissions "$c")
  new=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)
  case "$new" in
    "RTK_DB_PATH=$PROJ/.state/rtk/history.db RTK_RECALL=0 RTK_TELEMETRY_DISABLED=1 RTK_SUPPRESS_HOOK_WARNING=1 "*rtk*) ok "rewrite: $c -> $new" ;;
    *) fail "rewrite expected: $c (got: $out)" ;;
  esac
done
for c in "git push" "git status && rm -rf x" "git diff --output=x" "rg --pre x foo" "tree -o x" "uv run pytest" "curl https://x"; do
  out=$(run_guard bypassPermissions "$c")
  [ -z "$out" ] && ok "pass: $c" || fail "pass expected: $c (got: $out)"
done
# 비 bypass 모드: 일반 명령은 통과, rtk 직접 호출은 재작성
out=$(run_guard default "git status"); [ -z "$out" ] && ok "default mode git status passes" || fail "default mode rewrote"
out=$(run_guard default "rtk ls"); [ -n "$out" ] && ok "default mode direct rtk rewritten" || fail "default mode direct rtk not rewritten"
# 환경 가드
out=$(jq -cn '{permission_mode:"bypassPermissions",tool_input:{command:"git status"}}' | env -i HOME="$FAKE_HOME" PATH="$PATH" "$GUARD"); [ -z "$out" ] && ok "no CLAUDE_PROJECT_DIR passes" || fail "no project dir"
out=$(jq -cn '{permission_mode:"bypassPermissions",tool_input:{command:"git status"}}' | env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ" KB_JOB=1 "$GUARD"); [ -z "$out" ] && ok "KB_JOB passes" || fail "KB_JOB"
echo "garbage" | env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ" "$GUARD"; [ $? -eq 0 ] && ok "garbage input exit 0" || fail "garbage exit"
n=$(find "$FAKE_HOME" -type f | wc -l); [ "$n" -eq 0 ] && ok "fake HOME files 0" || fail "fake HOME files $n"
[ "$FAILS" -eq 0 ]
