#!/usr/bin/env bash
# svc.sh start <name> <cwd> <cmd...>   start in its own session, log to logs/<name>.log
# svc.sh stop  <name>                  SIGTERM the process group, then SIGKILL after 2 s
# svc.sh pid   <name>                  print pid
# svc.sh stopall                       stop everything with a pidfile
# svc.sh check                         list leftovers and bound spike ports
ROOT=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
RUN=$ROOT/run; LOGS=$ROOT/logs; mkdir -p "$RUN" "$LOGS"
cmd=$1; shift
stop_one() {
  local n=$1
  local f=$RUN/$n.pid
  [ -f "$f" ] || return 0
  local p; p=$(cat "$f")
  if kill -0 "$p" 2>/dev/null; then
    kill -TERM -"$p" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -"$p" 2>/dev/null
  fi
  rm -f "$f"
}
case "$cmd" in
  start)
    n=$1; cwd=$2; shift 2
    stop_one "$n"
    ( cd "$cwd" && exec setsid nohup "$@" >>"$LOGS/$n.log" 2>&1 </dev/null ) &
    echo $! >"$RUN/$n.pid"
    disown
    ;;
  stop) stop_one "$1" ;;
  pid) cat "$RUN/$1.pid" ;;
  stopall) for f in "$RUN"/*.pid; do [ -f "$f" ] && stop_one "$(basename "$f" .pid)"; done ;;
  check)
    echo "-- pidfiles:"; ls "$RUN" 2>/dev/null
    echo "-- spike processes:"; ps -eo pid,etimes,cmd | grep -E '[a]gentgateway-linux|[a]lpha.mjs|[b]eta(-legacy)?.mjs|[s]1-aggregation/c[0-9]' | cut -c1-140
    echo "-- bound $PB..$((PB+9)):"; ss -ltnp 2>/dev/null | grep -E "127.0.0.1:($PB|$((PB+1))|$((PB+2))|$((PB+3))|$((PB+4))|$((PB+5))|$((PB+6))|$((PB+7))|$((PB+8))|$((PB+9))) " | cut -c1-120
    ;;
esac
