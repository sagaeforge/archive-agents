#!/bin/sh
# PreToolUse Bash 훅. rtk 상태를 프로젝트 .state/rtk 로만 보낸다(전역 ~/.local/share/rtk 금지).
# 어느 단계든 실패하면 exit 0으로 원 명령을 통과시킨다.
[ -n "$CLAUDE_PROJECT_DIR" ] || exit 0
[ -z "$KB_JOB" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v rtk >/dev/null 2>&1 || exit 0
S="$CLAUDE_PROJECT_DIR/.state/rtk"
mkdir -p "$S" 2>/dev/null || exit 0
input=$(cat) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0
mode=$(printf '%s' "$input" | jq -r '.permission_mode // empty' 2>/dev/null)
PFX="RTK_DB_PATH=$S/history.db RTK_RECALL=0 RTK_TELEMETRY_DISABLED=1 RTK_SUPPRESS_HOOK_WARNING=1"

emit() { # $1=새 명령. 입력 JSON의 updatedInput만 바꾼다
  jq -cn --arg c "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecisionReason:"RTK project-scoped rewrite",updatedInput:{command:$c}}}' 2>/dev/null
}

# 메타문자가 있는지(개행 포함)
nl='
'
meta=0
case "$cmd" in
  *"$nl"*|*';'*|*'&'*|*'|'*|*'`'*|*'$'*|*'('*|*')'*|*'<'*|*'>'*|*'\'*|*'{'*|*'}'*|*'*'*|*'?'*|*'['*|*']'*|*'~'*|*'!'*|*'"'*|*"'"*|*'#'*) meta=1 ;;
esac

# 1) rtk 직접 호출: 모드와 무관하게 상태 경로를 붙인다
case "$cmd" in
  rtk|rtk\ *)
    if [ "$meta" = 0 ]; then new="$PFX $cmd"; else new="export $PFX; $cmd"; fi
    emit "$new" || exit 0
    exit 0 ;;
esac

# 2) 그 밖에는 bypassPermissions에서만
[ "$mode" = "bypassPermissions" ] || exit 0
[ "$meta" = 0 ] || exit 0

# 3) 허용 단일 명령
set -f
set -- $cmd
set +f
first=$1
case "$first" in
  git) case "$2" in status|diff|log|show) ;; *) exit 0 ;; esac ;;
  ls|rg|grep|tree) ;;
  *) exit 0 ;;
esac
for a in "$@"; do
  case "$a" in -o|--output|--output=*|--pre|--pre=*|--pre-glob*) exit 0 ;; esac
done

out=$(printf '%s' "$input" | env $PFX rtk hook claude 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
new=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null) || exit 0
[ -n "$new" ] || exit 0
printf '%s' "$out" | jq -c --arg c "$PFX $new" '.hookSpecificOutput.updatedInput.command=$c' 2>/dev/null || exit 0
exit 0
