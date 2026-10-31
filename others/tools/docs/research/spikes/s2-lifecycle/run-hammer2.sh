#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S; R=$S/out/hammer2.jsonl; : > $R; SECS=${1:-120}
v() { local n=$1 p=$2 m=$3 l=$4 i=$5 j=$6; shift 6
 sock_up $n $p -p StartLimitIntervalSec=0 --setenv=S2_LOG=$S/out/h-$n.jsonl "$@"
 sleep 0.3; $NODE hammer.mjs $p $m $i $j 4 $SECS $l >> $R 2>&1; sleep 0.7; sock_down $n; }
rm -f out/h-k*.jsonl
v k1 18241 keepalive g_fetch_ka100_buf0        300 15 --setenv=IDLE_MS=300 --setenv=KEEPALIVE_MS=100 --setenv=KA_BUFFER=0 &
v k2 18242 keepalive g_fetch_connclose         300 15 --setenv=IDLE_MS=300 --setenv=CONN_CLOSE=1 &
v k3 18243 nodeka    g_nodeagent_ka            300 15 --setenv=IDLE_MS=300 &
v k4 18244 nodeka    g_nodeagent_ka100_buf0    300 15 --setenv=IDLE_MS=300 --setenv=KEEPALIVE_MS=100 --setenv=KA_BUFFER=0 &
v k5 18245 nodeka    g_nodeagent_connclose     300 15 --setenv=IDLE_MS=300 --setenv=CONN_CLOSE=1 &
v k6 18246 nodeka    noexit_hostile_nodeagent  300 15 --setenv=IDLE_MS=0 --setenv=KEEPALIVE_MS=300 --setenv=KA_BUFFER=0 &
v k7 18247 keepalive noexit_hostile_fetch      300 15 --setenv=IDLE_MS=0 --setenv=KEEPALIVE_MS=300 --setenv=KA_BUFFER=0 &
wait
