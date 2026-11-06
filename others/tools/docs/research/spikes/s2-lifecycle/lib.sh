# helpers for transient socket-activated units. Nothing is written under ~/.config.
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/run-env.sh
sock_up() { # name port [systemd-run extra args...]
  local n=$1 p=$2; shift 2
  systemd-run --user --quiet --unit=s2lc-$n --socket-property=ListenStream=127.0.0.1:$p --working-directory=$S/app --setenv=STATIC_ROOT=../static "$@" $NODE server.mjs
}
sock_down() { local n=$1; systemctl --user stop s2lc-$n.socket s2lc-$n.service 2>/dev/null; systemctl --user reset-failed s2lc-$n.socket s2lc-$n.service 2>/dev/null; true; }
st() { systemctl --user show -p ActiveState -p SubState -p Result -p NRestarts --value s2lc-$1.$2 | tr '\n' ' '; echo; }
