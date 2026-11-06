#!/bin/bash
# helper the real client runs between MCP calls. Only touches this spike's transient units.
case "$1" in
  kill) systemctl --user kill -s KILL s2lc-d8.service ;;
  down) systemctl --user stop s2lc-pr4.service ;;
  up) . ../lib.sh; systemd-run --user --quiet --unit=s2lc-pr4 --working-directory=$S/app --setenv=IDLE_MS=0 --setenv=PORT=18271 --setenv=S2_LOG=$S/out/r4.jsonl $NODE server.mjs; sleep 1 ;;
esac
