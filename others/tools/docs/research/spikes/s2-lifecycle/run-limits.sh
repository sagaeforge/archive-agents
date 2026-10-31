#!/bin/bash
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
cd $S; R=out/restart.jsonl; : > $R
echo '--- restart under load'
for m in fresh fetch; do
 sock_up rs 18258 --setenv=IDLE_MS=0 -p StartLimitIntervalSec=0
 curl -s -o /dev/null 127.0.0.1:18258/healthz
 $NODE restart.mjs 18258 $m s2lc-rs.service 5 2000 socket_held >> $R; sock_down rs; sleep 0.3
 systemd-run --user --quiet --unit=s2lc-pl --working-directory=$S/app -p StartLimitIntervalSec=0 --setenv=IDLE_MS=0 --setenv=PORT=18259 $NODE server.mjs; sleep 0.8
 $NODE restart.mjs 18259 $m s2lc-pl.service 5 2000 plain_port >> $R; systemctl --user stop s2lc-pl.service; systemctl --user reset-failed s2lc-pl.service 2>/dev/null; sleep 0.3
done
echo '--- default limits: idle exit at 100ms, default StartLimit and TriggerLimit'
sock_up l1 18260 --setenv=IDLE_MS=100
for i in $(seq 1 40); do c=$(curl -s -m2 -o /dev/null -w '%{http_code}/%{exitcode}' 127.0.0.1:18260/healthz); echo "$i $c $(systemctl --user show -p ActiveState -p Result --value s2lc-l1.socket | tr '\n' ' ')"; sleep 0.25; done > out/limit-default.txt
awk '{print $2,$3,$4}' out/limit-default.txt | uniq -c | head -12
journalctl --user -u s2lc-l1.socket -u s2lc-l1.service --no-pager -n 6 -o cat 2>/dev/null | cut -c1-130
ss -ltn | grep -c 18260; sock_down l1
echo '--- crash at start behind the socket, default limits'
sock_up x1 18261 --setenv=FAIL_AT_START=1
python3 - <<'P'
import subprocess,time
t=time.time(); r=subprocess.run(['curl','-s','-m','40','-o','/dev/null','-w','%{http_code} exit=%{exitcode} %{errormsg}','http://127.0.0.1:18261/healthz'],capture_output=True,text=True); print('crash-at-start first client:',r.stdout,'after',round(time.time()-t,2),'s')
E2=subprocess.run(['curl','-s','-m','4','-o','/dev/null','-w','%{http_code} exit=%{exitcode} %{errormsg}','http://127.0.0.1:18261/healthz'],capture_output=True,text=True); print('second client:',E2.stdout)
P
echo "sock=$(st x1 socket) svc=$(st x1 service)"; systemctl --user show s2lc-x1.service -p NRestarts -p ExecMainStatus | tr '\n' ' '; echo; sock_down x1
echo '--- hung at start: never calls listen. Client behaviour'
cat > app/hang.mjs <<'H'
setInterval(() => {}, 1000);
H
systemd-run --user --quiet --unit=s2lc-hg --socket-property=ListenStream=127.0.0.1:18262 --working-directory=$S/app $NODE hang.mjs
python3 - <<'P'
import subprocess,time
t=time.time(); r=subprocess.run(['curl','-s','-m','8','-o','/dev/null','-w','%{http_code} exit=%{exitcode} %{errormsg}','http://127.0.0.1:18262/healthz'],capture_output=True,text=True); print('hung app client:',r.stdout,'after',round(time.time()-t,2),'s')
P
sock_down hg
