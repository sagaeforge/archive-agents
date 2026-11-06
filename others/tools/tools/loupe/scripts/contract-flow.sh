#!/bin/bash
# The contract flow (design 8, ported from S4): fixtures -> generation -> tsc -> typed client and mock rules -> Schemathesis -> controls -> guard.
# Usage: npm run contract:flow     Logs: $LOUPE_LOG_DIR (default .cache/logs). Sockets for the proxy tests: $LOUPE_SOCKET_DIR (default .cache/sock).
set -u
cd "$(dirname "$0")/.."
[ -d "${LOUPE_NODE_DIR:-/home/user/.nvm/versions/node/v26.13.0/bin}" ] && export PATH="${LOUPE_NODE_DIR:-/home/user/.nvm/versions/node/v26.13.0/bin}:$PATH"
export LOUPE_LOG_DIR=${LOUPE_LOG_DIR:-$PWD/.cache/logs}; LOG=$LOUPE_LOG_DIR; mkdir -p "$LOG"
export LOUPE_SOCKET_DIR=${LOUPE_SOCKET_DIR:-$PWD/.cache/sock}; mkdir -p "$LOUPE_SOCKET_DIR"
FAIL=0
step() { printf '[%s] ' "$1"; }
run() { local name=$1; shift; "$@" > "$LOG/$name.txt" 2>&1; local rc=$?; [ $rc -ne 0 ] && FAIL=1; echo "rc=$rc  $(tail -n 1 "$LOG/$name.txt" | cut -c1-160)"; return $rc; }

step "1 fixtures vs spec (ajv)";           run fixtures node scripts/validate-fixtures.ts
step "2 spec checks (paths, time axes)";   run check-spec node scripts/check-spec.ts
step "3 generate (orval + stamp)";         run gen sh -c 'npx orval --config orval.config.mjs && node scripts/stamp.ts'
step "4 tsc (client, assertions, mock)";   run tsc npx tsc -p . --pretty false
step "5 typed client, mock rules, proxy";  run vitest npx vitest run
step "6 schemathesis, seeds 1 to 5";       echo; bash scripts/schemathesis.sh 1 2 3 4 5 | tee "$LOG/schemathesis.txt"; [ "${PIPESTATUS[0]}" -ne 0 ] && FAIL=1
# Negative controls: Schemathesis must fail on each planted bug, otherwise a green run means nothing.
for bug in drop_field wrong_error_type; do
  step "7 control KB_MOCK_BUG=$bug (must fail)"
  KB_MOCK_BUG=$bug KB_ST_EXAMPLES=30 KB_ST_EXTRA="--max-failures 1 --phases fuzzing" bash scripts/schemathesis.sh 1 > "$LOG/control-$bug.txt" 2>&1; rc=$?
  if [ $rc -eq 0 ]; then FAIL=1; echo "NOT CAUGHT"; else echo "caught (rc=$rc)"; fi
done
step "8 contract:guard";                   run guard node scripts/contract-guard.mjs
echo; [ $FAIL -eq 0 ] && echo "CONTRACT FLOW PASSED" || echo "CONTRACT FLOW FAILED (see $LOG)"
exit $FAIL
