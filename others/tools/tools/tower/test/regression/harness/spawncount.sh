#!/usr/bin/env bash
# One modern request per line; reports how many beta processes each one spawned.
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
URL=$1; BEARER=$2; shift 2
: > $S/logs/beta-spawn.log
for m in "$@"; do
  b=$(grep -c '"spawn"' $S/logs/beta-spawn.log)
  node $S/harness/modern1.mjs "$URL" "$BEARER" $m
  sleep 0.4
  a=$(grep -c '"spawn"' $S/logs/beta-spawn.log)
  echo "   ^^ [$m] beta spawns: $((a-b))"
done
