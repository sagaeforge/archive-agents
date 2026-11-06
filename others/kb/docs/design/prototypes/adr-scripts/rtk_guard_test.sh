#!/bin/bash
SP=<SCRATCHPAD>
G=$SP/adr/rtktest; rm -rf $G; mkdir -p $G/home $G/repo/.state/rtk; cd $G/repo; git init -q .; echo x>a.txt; git add a.txt
cat > $G/guard.sh <<'EOF'
#!/bin/sh
# 허용 목록 + 상태 경로 접두사. rtk 재작성 결과에 프로젝트 상태 경로를 붙인다
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
mode=$(printf '%s' "$input" | jq -r '.permission_mode // empty')
[ "$mode" = "bypassPermissions" ] || exit 0
case "$cmd" in *[\;\&\|\>\<\`\$\(\)]*|*'
'*) exit 0 ;; esac
case "$cmd" in
  *' --output'*|*' -o '*|*' --pre'*|*'--output='*) exit 0 ;;
esac
case "$cmd" in
  'git status'|'git status '*|'git diff'|'git diff '*|'git log'|'git log '*|'git show'|'git show '*|'ls'|'ls '*|'rg '*|'grep '*|'tree'|'tree '*) ;;
  *) exit 0 ;;
esac
out=$(printf '%s' "$input" | rtk hook claude) || exit 0
[ -n "$out" ] || exit 0
new=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty')
[ -n "$new" ] || exit 0
pre="RTK_DB_PATH=$KB_RTK_STATE/history.db RTK_RECALL=0 RTK_TELEMETRY_DISABLED=1"
printf '%s' "$out" | jq --arg c "$pre $new" '.hookSpecificOutput.updatedInput.command=$c'
EOF
chmod +x $G/guard.sh
E="env -i HOME=$G/home PATH=/home/<user>/.local/bin:/usr/bin:/bin KB_RTK_STATE=$G/repo/.state/rtk"
for c in 'git status' 'git log -n 1' 'git diff --output=x' 'rg --pre x foo' 'tree -o x' 'git push origin main' 'git status && rm -rf x' 'ls -la'; do
  J=$(jq -nc --arg c "$c" --arg d "$G/repo" '{tool_name:"Bash",tool_input:{command:$c},permission_mode:"bypassPermissions",cwd:$d,hook_event_name:"PreToolUse"}')
  R=$(printf '%s' "$J" | $E $G/guard.sh | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null); echo "[$c] -> ${R:-(통과)}" | sed "s#$G#G#g"
done
J=$(jq -nc --arg d "$G/repo" '{tool_name:"Bash",tool_input:{command:"git status"},permission_mode:"default",cwd:$d,hook_event_name:"PreToolUse"}'); echo "default 모드 출력 바이트: $(printf '%s' "$J" | $E $G/guard.sh | wc -c)"
J=$(jq -nc --arg d "$G/repo" '{tool_name:"Bash",tool_input:{command:"git status"},permission_mode:"bypassPermissions",cwd:$d,hook_event_name:"PreToolUse"}')
cmd=$(printf '%s' "$J" | $E $G/guard.sh | jq -r .hookSpecificOutput.updatedInput.command)
echo "실행: $cmd" | sed "s#$G#G#g"; $E sh -c "$cmd" | head -3
echo "--- 가짜 HOME 파일"; find $G/home -type f | sed "s#$G#G#g"
echo "--- 저장소 상태"; ls -la $G/repo/.state/rtk | awk '{print $5,$9}'
