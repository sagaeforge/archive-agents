#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S
sock_up s2 18257 --setenv=IDLE_MS=1000 --setenv=S2_LOG=$S/out/s2.jsonl
timeout 20 curl -s -N 'http://127.0.0.1:18257/sse?every=100' > out/sse-active.txt &
C=$!; sleep 10; P1=$(systemctl --user show -p MainPID --value s2lc-s2.service); sleep 9; P2=$(systemctl --user show -p MainPID --value s2lc-s2.service); echo "active-SSE pid@10s=$P1 pid@19s=$P2"
wait $C; t=$(date +%s.%N); for i in $(seq 1 100); do [ "$(systemctl --user show -p SubState --value s2lc-s2.service)" = dead ] && break; sleep 0.05; done; echo "exit after disconnect: $(python3 -c "import time;print(round(time.time()-$t,2))")s ticks=$(grep -c '^data:' out/sse-active.txt)"
sleep 0.5
timeout 30 curl -s -N 'http://127.0.0.1:18257/sse?every=100' > out/sse-term.txt &
C=$!; sleep 1
python3 -c "
import subprocess,time
t=time.time();subprocess.run(['systemctl','--user','stop','s2lc-s2.service'],stderr=subprocess.DEVNULL);print('systemctl stop with open SSE took',round(time.time()-t,2),'s')"
kill $C 2>/dev/null; wait $C 2>/dev/null
grep -E '"ev":"(shutdown|closed)"' out/s2.jsonl | tail -2 | cut -c1-110
sock_down s2
