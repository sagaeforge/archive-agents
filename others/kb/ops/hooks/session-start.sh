#!/bin/sh
# SessionStart 훅. KB_JOB이 있으면 아무것도 하지 않는다.
[ -z "$KB_JOB" ] || exit 0
P="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
KB="${KB_BIN:-/home/user/sagae-kb-data/runtime/bin/kb}"

# graft/ 맵이 없으면 trail build (프로젝트 안에서만)
if [ ! -d "$P/graft" ] && command -v trail >/dev/null 2>&1; then
  (cd "$P" && timeout 120 trail build >/dev/null 2>&1) || true
fi

# 배포 전이면 조용히 끝
[ -x "$KB" ] || exit 0

ctx=""
if ! ctx=$("$KB" status --critical 2>&1); then
  ctx="kb status --critical 실행 실패(exit $?): $ctx"
fi

# collect.session_tick=true 이고 만기일 때만 kb tick을 배경으로
cfg="${KB_CONFIG_DIR:-$HOME/.config/sagae-kb}/config.toml"
st=$(python3 - "$cfg" <<'PY' 2>/dev/null
import sys, tomllib
try:
    d = tomllib.load(open(sys.argv[1], "rb"))
    print("1" if d.get("collect", {}).get("session_tick") is True else "0")
except Exception:
    print("0")
PY
)
if [ "$st" = "1" ] && command -v jq >/dev/null 2>&1; then
  j=$("$KB" status --json 2>/dev/null) || j=""
  due=$(printf '%s' "$j" | jq -r '(.freshness.last_tick_age_s // 0) > 3600 or ((.freshness.stale_sources // 0) > 0)' 2>/dev/null)
  if [ "$due" = "true" ]; then
    (nohup "$KB" tick >/dev/null 2>&1 &) 
  fi
fi

[ -n "$ctx" ] || exit 0
command -v jq >/dev/null 2>&1 || { printf '%s\n' "$ctx"; exit 0; }
jq -cn --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
