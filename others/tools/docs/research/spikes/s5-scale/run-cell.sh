#!/bin/bash
# usage: run-cell.sh "<query>" [timeoutSec]   Opens an Orca tab at the query, pumps eval so the first rAF fires, waits for one new result line, closes tab.
cd "$(dirname "$0")"
Q="$1"; T=${2:-240}; OI=/home/user/.local/bin/orca-ide
touch out/results-s5.jsonl; N0=$(wc -l < out/results-s5.jsonl)
J=$($OI tab create --worktree path:/home/user/sagae-tools --url "http://127.0.0.1:18511/?$Q" --json </dev/null 2>&1)
PID=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.browserPageId)}catch(e){console.log("")}})')
echo "tab=$PID q=$Q"
[ -z "$PID" ] && { echo "$J"; exit 1; }
S=$(date +%s); I=0
while [ $(( $(date +%s) - S )) -lt $T ]; do
  [ "$(wc -l < out/results-s5.jsonl)" -gt "$N0" ] && break
  if [ -n "$PUMP" ] || [ $I -lt 6 ] || [ $((I % 5)) -eq 0 ]; then $OI eval --page "$PID" --expression 'document.visibilityState+" "+document.hasFocus()' --json </dev/null > out/eval-last.json 2>&1; fi
  I=$((I+1)); sleep ${SLEEP:-2}
done
[ "$(wc -l < out/results-s5.jsonl)" -gt "$N0" ] && echo "RESULT ok after $(( $(date +%s) - S ))s" || echo "TIMEOUT"
tail -n1 out/eval-last.json | head -c 300; echo
$OI tab close --page "$PID" --worktree path:/home/user/sagae-tools --json </dev/null > /dev/null 2>&1
