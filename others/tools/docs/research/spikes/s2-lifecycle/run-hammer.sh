#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S; R=$S/out/hammer.jsonl; : > $R; SECS=${1:-120}
v() { # name port mode label idle jitter envs...
 local n=$1 p=$2 m=$3 l=$4 i=$5 j=$6; shift 6
 sock_up $n $p -p StartLimitIntervalSec=0 --setenv=S2_LOG=$S/out/h-$n.jsonl "$@"
 sleep 0.3
 $NODE hammer.mjs $p $m $i $j 4 $SECS $l >> $R 2>&1
 sleep 0.7; echo "$l sock=$(st $n socket) svc=$(st $n service)" >> $S/out/hammer-state.txt
 sock_down $n
}
: > out/hammer-state.txt; rm -f out/h-*.jsonl
v h1 18221 fresh     graceful_fresh      300 15 --setenv=IDLE_MS=300 &
v h2 18222 keepalive graceful_keepalive  300 15 --setenv=IDLE_MS=300 &
v h3 18223 fresh     naive_fresh         300 15 --setenv=IDLE_MS=300 --setenv=SHUTDOWN=naive &
v h4 18224 keepalive naive_keepalive     300 15 --setenv=IDLE_MS=300 --setenv=SHUTDOWN=naive &
v h5 18225 keepalive graceful_ka_short   300 15 --setenv=IDLE_MS=300 --setenv=KEEPALIVE_MS=100 &
v h6 18226 keepalive control_no_exit     300 15 --setenv=IDLE_MS=0 &
wait
