#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S
P1='Call mcp__s2__ping once, then reply with its raw result. Do nothing else.'
Q='If a tool named mcp__s2__ping is available, call it once and reply PINGED followed by its raw result. If it is not available, or the call fails, reply NO_TOOL and the reason in one short line. Do nothing else.'
# R2c: no listChanged capability: does Claude Code still open subscriptions/listen?
( sock_up c2c 18250 --setenv=IDLE_MS=1500 --setenv=NO_LISTCHANGED=1 --setenv=S2_LOG=$S/out/r2c.jsonl
  ./cc.sh r2c 18250 "" mcp__s2__ping "$P1" > out/res-r2c.json; sock_down c2c ) &
# R2d: long session while the process exits under the listen stream
W='Run the Bash command: ./wait.sh 150 with a Bash timeout of 200000 ms in the foreground. Then call mcp__s2__ping once and reply with its raw result, or with the error text. Do nothing else.'
( sock_up c2d 18251 --setenv=IDLE_MS=1500 --setenv=IGNORE_LISTEN=1 --setenv=S2_LOG=$S/out/r2d.jsonl -p StartLimitIntervalSec=0
  ./cc.sh r2d 18251 Bash "mcp__s2__ping,Bash(./wait.sh 150)" "$W" > out/res-r2d.json; sock_down c2d ) &
# R3e: plain server appears only after startup retries are exhausted
E2='Run the Bash command: ./wait.sh 170 with a Bash timeout of 200000 ms in the foreground. Then, if a tool named mcp__s2__ping is available, call it once and reply PINGED followed by its raw result. If it is not available, reply NO_TOOL. Do nothing else.'
( ( sleep 140; systemd-run --user --quiet --unit=s2lc-pr3e --working-directory=$S/app --setenv=IDLE_MS=0 --setenv=PORT=18265 --setenv=S2_LOG=$S/out/r3e.jsonl $NODE server.mjs ) &
  ./cc.sh r3e 18265 Bash "mcp__s2__ping,Bash(./wait.sh 170)" "$E2" > out/res-r3e.json; wait; systemctl --user stop s2lc-pr3e.service ) &
# R6: crash at start behind the socket
( sock_up c6 18266 --setenv=FAIL_AT_START=1
  ./cc.sh r6 18266 "" mcp__s2__ping "$Q" > out/res-r6.json; echo "sock=$(st c6 socket)" > out/res-r6.state; sock_down c6 ) &
# R7: app hangs before listen behind the socket
( systemd-run --user --quiet --unit=s2lc-c7 --socket-property=ListenStream=127.0.0.1:18267 --working-directory=$S/app $NODE hang.mjs
  ./cc.sh r7 18267 "" mcp__s2__ping "$Q" > out/res-r7.json; sock_down c7 ) &
wait
