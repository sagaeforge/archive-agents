#!/bin/bash
# Usage: scripts/schemathesis.sh [seeds...]   Runs Schemathesis against a kb-mock it starts itself (port 4833).
# Another target: KB_ST_URL=http://127.0.0.1:4812/kb scripts/schemathesis.sh (trigger T3, no mock is started then).
set -u
cd "$(dirname "$0")/.."
[ -d "${LOUPE_NODE_DIR:-/home/user/.nvm/versions/node/v26.13.0/bin}" ] && export PATH="${LOUPE_NODE_DIR:-/home/user/.nvm/versions/node/v26.13.0/bin}:$PATH"
LOG=${LOUPE_LOG_DIR:-.cache/logs}; mkdir -p "$LOG"
export SCHEMATHESIS_TELEMETRY=false SCARF_ANALYTICS=false HYPOTHESIS_STORAGE_DIRECTORY="${HYPOTHESIS_STORAGE_DIRECTORY:-$PWD/.cache/hypothesis}"
SPEC=${KB_CONTRACT:-${KB_CONTRACTS_DIR:-/home/user/sagae-knowloge-base/docs/contracts}/openapi.yaml}
SEEDS=${*:-1 2 3 4 5}
PORT=${KB_ST_PORT:-4833}
URL=${KB_ST_URL:-http://127.0.0.1:$PORT}
MOCK=
if [ -z "${KB_ST_URL:-}" ]; then
  # Never probe a closed loopback port with a connect: on this host it hangs instead of being refused (design 11).
  if ss -ltn | grep -q "127.0.0.1:$PORT "; then echo "port $PORT busy"; exit 9; fi
  rm -f "$LOG/access.log"
  KB_MOCK_PORT=$PORT KB_ACCESS_LOG="$LOG/access.log" node dev/kb-mock/main.ts > "$LOG/mock-st.log" 2>&1 &
  MOCK=$!; trap '[ -n "$MOCK" ] && kill $MOCK 2>/dev/null' EXIT
  UP=
  for _ in $(seq 1 50); do grep -q "kb-mock on" "$LOG/mock-st.log" 2>/dev/null && UP=1 && break; sleep 0.2; done
  [ -z "$UP" ] && { echo "kb-mock did not start: $(cat "$LOG/mock-st.log")"; exit 8; }
fi
RC=0
for s in $SEEDS; do
  # No --checks flag: it would override the per-operation switches in schemathesis.toml.
  .cache/st-venv/bin/st --config-file schemathesis.toml run "$SPEC" --url "$URL" --seed "$s" --max-examples "${KB_ST_EXAMPLES:-100}" --no-color ${KB_ST_EXTRA:-} > "$LOG/st-seed-$s.txt" 2>&1
  rc=$?; [ $rc -ne 0 ] && RC=1
  echo "seed $s rc=$rc $(grep -E '^ +[0-9]+ generated' "$LOG/st-seed-$s.txt" | tr -s ' ')"
done
if [ -n "$MOCK" ]; then
  echo "5xx in the access log: $(grep -cE ' 5[0-9][0-9]$' "$LOG/access.log")"
fi
exit $RC
