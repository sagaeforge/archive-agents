#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S
DESIGN=(-p Restart=always -p RestartSec=1 -p StartLimitIntervalSec=0 -p TimeoutStopSec=8 --socket-property=NoDelay=true)
echo '--- D1 bad deploy: crash at start for 7s, then fixed. Pending client and socket state'
F=$S/out/failflag; touch $F
sock_up d7 18269 "${DESIGN[@]}" --setenv=IDLE_MS=0 --setenv=FAIL_FLAG=$F
python3 - <<'P' &
import subprocess,time
t=time.time(); r=subprocess.run(['curl','-s','-m','25','-o','/dev/null','-w','%{http_code} exit=%{exitcode} %{errormsg}','http://127.0.0.1:18269/healthz'],capture_output=True,text=True); print('pending client:',r.stdout,'after',round(time.time()-t,2),'s')
P
sleep 7; echo "at 7s sock=$(st d7 socket) svc=$(st d7 service)"; rm -f $F; wait
echo "after fix sock=$(st d7 socket) svc=$(st d7 service)"; sock_down d7
echo '--- D2 real client on the design unit: SIGKILL between calls'
sock_up d8 18270 "${DESIGN[@]}" --setenv=IDLE_MS=0 --setenv=S2_LOG=$S/out/r8.jsonl
P='Do these steps in strict order, one at a time: (1) call mcp__s2__ping; (2) run the Bash command: ./ctl.sh kill; (3) run the Bash command: ./wait.sh 4; (4) call mcp__s2__ping. Then reply with the two raw ping results, one per line. If a ping fails, report the error text for that step.'
./cc.sh r8 18270 Bash "mcp__s2__ping,Bash(./ctl.sh kill),Bash(./wait.sh 4)" "$P"
sock_down d8
echo '--- R4 plain process stopped and restarted between calls'
./cc-cwd/ctl.sh x; ( cd cc-cwd; ./ctl.sh up )
P='Do these steps in strict order, one at a time: (1) call mcp__s2__ping; (2) run the Bash command: ./ctl.sh down; (3) run the Bash command: ./wait.sh 3; (4) call mcp__s2__ping; (5) run the Bash command: ./ctl.sh up; (6) call mcp__s2__ping. Then reply with the outcome of each ping, one per line, quoting any error text.'
./cc.sh r4 18271 Bash "mcp__s2__ping,Bash(./ctl.sh down),Bash(./ctl.sh up),Bash(./wait.sh 3)" "$P"
systemctl --user stop s2lc-pr4.service 2>/dev/null; systemctl --user reset-failed s2lc-pr4.service 2>/dev/null
echo '--- single instance memory'
sock_up m1 18272 --setenv=IDLE_MS=0
curl -s -o /dev/null 127.0.0.1:18272/healthz; sleep 30
pid=$(systemctl --user show -p MainPID --value s2lc-m1.service); grep -E '^(Rss|Pss|Private_Clean|Private_Dirty|Shared_Clean):' /proc/$pid/smaps_rollup | tr -s ' ' | tr '\n' ' '; echo; grep -E 'VmHWM|VmRSS|Threads' /proc/$pid/status | tr -s ' \t' ' ' | tr '\n' ' '; echo; systemctl --user show -p MemoryCurrent -p MemoryPeak --value s2lc-m1.service | tr '\n' ' '; echo
sock_down m1
