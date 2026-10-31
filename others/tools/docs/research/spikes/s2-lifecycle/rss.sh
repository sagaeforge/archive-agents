#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S; R=out/rss.tsv; printf 'inst\tphase\tVmRSS_kB\tPss_kB\tMemoryCurrent\n' > $R
snap() { for i in 1 2 3 4 5; do n=r$i; pid=$(systemctl --user show -p MainPID --value s2lc-$n.service); printf "$i\t$1\t%s\t%s\t%s\n" "$(awk '/VmRSS/{print $2}' /proc/$pid/status)" "$(awk '/^Pss:/{print $2}' /proc/$pid/smaps_rollup)" "$(systemctl --user show -p MemoryCurrent --value s2lc-$n.service)" >> $R; done; }
for i in 1 2 3 4 5; do sock_up r$i $((18230+i)) --setenv=IDLE_MS=0; done
sleep 0.3
for i in 1 2 3 4 5; do curl -s -m5 -o /dev/null 127.0.0.1:$((18230+i))/healthz; done
sleep 5; snap fresh_5s
B='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
for i in 1 2 3 4 5; do p=$((18230+i)); ( for k in $(seq 1 300); do curl -s -o /dev/null -X POST 127.0.0.1:$p/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' -d "$B"; done ) & done; wait
snap after_300_mcp
sleep 60; snap idle_60s
for i in 1 2 3 4 5; do sock_down r$i; done
