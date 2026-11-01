#!/bin/bash
. "$(dirname "$0")/common.sh"
HOOK="$ROOT/ops/hooks/session-start.sh"
mkdir -p "$PROJ/graft"   # trail build 생략
CALLS="$W/calls"; : > "$CALLS"
mkfake() { # $1=status exit
cat > "$W/kb" <<K
#!/bin/sh
echo "\$*" >> "$CALLS"
case "\$1 \$2" in
  "status --critical") echo "치명 0건. 경고 3건"; exit $1 ;;
  "status --json") echo '{"freshness":{"last_tick_age_s":7200,"stale_sources":0}}'; exit 0 ;;
esac
[ "\$1" = tick ] && exit 0
exit 0
K
chmod +x "$W/kb"; }
run() { env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ" KB_BIN="$W/kb" KB_CONFIG_DIR="$W/cfg" "$@" "$HOOK"; }
mkdir -p "$W/cfg"
mkfake 0
# KB_JOB
: > "$CALLS"; out=$(run KB_JOB=1); [ ! -s "$CALLS" ] && [ -z "$out" ] && ok "KB_JOB: kb 호출 0회" || fail "KB_JOB calls"
# 기본: tick 0회, 경고 건수 출력
: > "$CALLS"; out=$(run); 
printf '%s' "$out" | jq -r .hookSpecificOutput.additionalContext | grep -q "경고 3건" && ok "경고 건수 출력" || fail "경고 건수 ($out)"
grep -q '^tick' "$CALLS" && fail "기본에서 tick 호출" || ok "기본: tick 0회"
# true
printf '[collect]\nsession_tick = true\n' > "$W/cfg/config.toml"
: > "$CALLS"; run >/dev/null; sleep 1
[ "$(grep -c '^tick' "$CALLS")" -eq 1 ] && ok "session_tick=true: tick 1회" || fail "tick count $(grep -c '^tick' "$CALLS")"
rm "$W/cfg/config.toml"
# kb 실패
mkfake 3; out=$(run)
printf '%s' "$out" | jq -r .hookSpecificOutput.additionalContext | grep -q "실행 실패" && ok "kb 실패가 additionalContext에 나옴" || fail "kb 실패 ($out)"
# kb 없음
out=$(env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ" KB_BIN="$W/nokb" "$HOOK"); rc=$?
[ $rc -eq 0 ] && [ -z "$out" ] && ok "kb 없음: 조용히 종료" || fail "kb 없음 rc=$rc out=$out"
n=$(find "$FAKE_HOME" -type f | wc -l); [ "$n" -eq 0 ] && ok "fake HOME files 0" || fail "fake HOME files $n"
[ "$FAILS" -eq 0 ]
