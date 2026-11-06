#!/usr/bin/env bash
# One modern request per line; reports how many beta processes each one spawned.
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
URL=$1; BEARER=$2; shift 2
: > $S/logs/beta-spawn.log
for m in "$@"; do
  b=$(grep -c '"spawn"' $S/logs/beta-spawn.log)
  node $S/harness/modern1.mjs "$URL" "$BEARER" $m
  sleep 0.4
  a=$(grep -c '"spawn"' $S/logs/beta-spawn.log)
  echo "   ^^ [$m] beta spawns: $((a-b))"
done
