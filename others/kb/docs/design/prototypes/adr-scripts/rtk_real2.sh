#!/bin/bash
SP=<SCRATCHPAD>
G=$SP/adr/rtkreal2; rm -rf $G; mkdir -p $G/repo/.state/rtk $G/repo/.claude $G/repo/ops/hooks $G/log $G/fakehome; cd $G/repo; git init -q .; echo x>a.txt; git add a.txt
cat > ops/hooks/rtk-guard.sh <<EOF
#!/bin/sh
# 시험용: 모드 검사를 뺐고 rtk가 보는 HOME을 가짜로 고정한다. 누출되면 가짜 HOME에 파일이 생긴다
[ -n "\$CLAUDE_PROJECT_DIR" ] || exit 0
S="\$CLAUDE_PROJECT_DIR/.state/rtk"
input=\$(cat)
cmd=\$(printf '%s' "\$input" | jq -r '.tool_input.command // empty')
case "\$cmd" in 'git status'|'git status '*|'ls'|'ls '*) ;; *) exit 0 ;; esac
out=\$(printf '%s' "\$input" | HOME=$G/fakehome RTK_DB_PATH="\$S/history.db" RTK_RECALL=0 RTK_TELEMETRY_DISABLED=1 rtk hook claude) || exit 0
[ -n "\$out" ] || exit 0
new=\$(printf '%s' "\$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty')
[ -n "\$new" ] || exit 0
printf '%s' "\$out" | jq --arg c "HOME=$G/fakehome RTK_DB_PATH=\$S/history.db RTK_RECALL=0 RTK_TELEMETRY_DISABLED=1 \$new" '.hookSpecificOutput.updatedInput.command=\$c'
EOF
chmod +x ops/hooks/rtk-guard.sh
cat > .claude/settings.json <<'J'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ops/hooks/rtk-guard.sh","timeout":10}]}]}}
J
sha256sum ~/.local/share/rtk/history.db | cut -c1-16 > $G/log/before; stat -c %Y ~/.local/share/rtk/history.db >> $G/log/before
env -i HOME="$HOME" PATH="/home/<user>/.local/bin:/home/<user>/.nvm/versions/node/v26.13.0/bin:/usr/bin:/bin" LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 \
  timeout 90 /home/<user>/.local/bin/claude -p 'Run exactly this bash command once and report its output: git status' \
  --setting-sources project --strict-mcp-config --tools Bash --allowedTools Bash --model haiku --max-turns 3 --max-budget-usd 0.03 --no-session-persistence --output-format stream-json --verbose </dev/null > $G/log/stream.jsonl 2> $G/log/err.txt
echo rc=$?
jq -r 'select(.type=="result")|[.subtype,.is_error,.total_cost_usd]|@tsv' $G/log/stream.jsonl
jq -r 'select(.type=="user")|.message.content[]?|select(.type=="tool_result")|.content' $G/log/stream.jsonl 2>/dev/null | head -3
echo "가짜 HOME 파일: $(find $G/fakehome -type f | wc -l)"
ls -la .state/rtk | awk '{print $5,$9}'
sha256sum ~/.local/share/rtk/history.db | cut -c1-16 > $G/log/after; stat -c %Y ~/.local/share/rtk/history.db >> $G/log/after
diff $G/log/before $G/log/after && echo "전역 history.db 불변"
