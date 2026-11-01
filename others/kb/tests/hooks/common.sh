# 시험 공용: 가짜 HOME과 가짜 프로젝트. rtk가 전역을 건드리면 FAKE_HOME에 파일이 생긴다.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${KB_TMP:-${TMPDIR:-$HOME/.cache/sagae-kb}/hooks-test}"
mkdir -p "$BASE"
W=$(mktemp -d "$BASE/hk.XXXXXX")
FAKE_HOME="$W/fake-home"; PROJ="$W/proj"
mkdir -p "$FAKE_HOME" "$PROJ"
trap 'rm -rf "$W"' EXIT
GUARD="$ROOT/ops/hooks/rtk-guard.sh"
FAILS=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS+1)); }
# run_guard <permission_mode> <command> -> stdout
run_guard() {
  jq -cn --arg m "$1" --arg c "$2" '{session_id:"s1",tool_use_id:"t1",hook_event_name:"PreToolUse",tool_name:"Bash",permission_mode:$m,tool_input:{command:$c}}' |
    env -i HOME="$FAKE_HOME" PATH="$PATH" CLAUDE_PROJECT_DIR="$PROJ" "$GUARD"
}
