#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S; R=$S/out/cold-summary.jsonl; : > $R; mkdir -p $S/out/cc
cat /proc/loadavg | tee -a $S/out/cold-load.txt
one() { # unit port kind N entry extra...
 local n=$1 p=$2 k=$3 N=$4 e=$5; shift 5
 systemd-run --user --quiet --unit=s2lc-$n --socket-property=ListenStream=127.0.0.1:$p --working-directory=$S/app -p StartLimitIntervalSec=0 --setenv=IDLE_MS=100 "$@" $NODE $e
 $NODE coldstart.mjs $n $p $k $N > out/cold-$n-$k.jsonl 2>> $R
 sock_down $n
}
N=${1:-30}
one c1 18211 healthz $N rawnode.mjs
one c2 18212 healthz $N bare.mjs
one c3 18213 healthz $N server.mjs
one c4 18214 mcp     $N server.mjs
# compile cache: warmed by the first run
one c5 18215 healthz $N server.mjs --setenv=NODE_COMPILE_CACHE=$S/out/cc
one c6 18216 mcp     $N server.mjs --setenv=NODE_COMPILE_CACHE=$S/out/cc
cat /proc/loadavg | tee -a $S/out/cold-load.txt
