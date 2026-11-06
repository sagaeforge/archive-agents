#!/bin/bash
. "$(dirname "$0")/common.sh"
cd "$PROJ" && git init -q . && echo x > a.txt && git add a.txt
E=(env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ")
# 훅 프로세스 + 재작성 명령 + 직접 호출 rtk
for c in "git status" "ls -la" "rtk git status"; do
  out=$(run_guard bypassPermissions "$c")
  new=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty')
  [ -n "$new" ] || { fail "no rewrite: $c"; continue; }
  (cd "$PROJ" && env -i HOME="$FAKE_HOME" PATH="$PATH" bash -c "$new" >/dev/null 2>&1)
done
n=$(find "$FAKE_HOME" -type f | wc -l)
[ "$n" -eq 0 ] && ok "fake HOME files 0" || { fail "fake HOME files $n"; find "$FAKE_HOME" -type f; }
DB="$PROJ/.state/rtk/history.db"
[ -f "$DB" ] || { fail "no project db"; [ "$FAILS" -eq 0 ]; exit; }
for t in commands hook_decisions; do
  r=$(sqlite3 "$DB" "select count(*) from $t" 2>/dev/null || python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select count(*) from $t').fetchone()[0])" "$DB")
  [ "${r:-0}" -ge 1 ] && ok "$t rows=$r" || fail "$t rows=${r:-none}"
done
[ "$FAILS" -eq 0 ]
