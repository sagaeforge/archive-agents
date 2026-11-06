#!/usr/bin/env bash
# register-user.sh [--apply]
# 다른 프로젝트 세션에서 kb-mcp를 쓰도록 사용자 범위(~/.claude.json)에 등록한다(ADR 15.4 선택지 A).
# 기본은 건식 실행이다: 실행할 명령만 출력하고 claude를 부르지 않는다.
# --apply는 사용자 결정 7이 승인된 뒤에만 돈다(승인 기록은 $KB_CONFIG_DIR/decisions.toml의 approved).
# ~/.claude.json을 직접 편집하지 않고 `claude mcp add --scope user`를 쓴다.
set -euo pipefail
APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    *) echo "알 수 없는 인수: $a" >&2; exit 2 ;;
  esac
done
CLAUDE="${KB_CLAUDE_BIN:-claude}"
KB_MCP="${KB_MCP_BIN:-/home/user/sagae-kb-data/runtime/bin/kb-mcp}"
CMD=("$CLAUDE" mcp add --scope user kb -- "$KB_MCP")
if [ "$APPLY" = 0 ]; then
  echo "건식 실행(변경 없음). 사용자 결정 7 승인 뒤 --apply로 아래 명령을 실행한다:"
  echo "  ${CMD[*]}"
  exit 0
fi
CFG="${KB_CONFIG_DIR:-$HOME/.config/sagae-kb}/decisions.toml"
ok="$(python3 -I - "$CFG" <<'P'
import sys, tomllib
try:
    with open(sys.argv[1], "rb") as f:
        print("yes" if 7 in (tomllib.load(f).get("approved") or []) else "no")
except Exception:
    print("no")
P
)"
if [ "$ok" != "yes" ]; then
  echo "거부: 사용자 결정 7이 $CFG 의 approved에 없다. --apply를 돌리지 않는다." >&2
  exit 3
fi
exec "${CMD[@]}"
