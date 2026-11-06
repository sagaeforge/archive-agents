#!/bin/bash
SP=<SCRATCHPAD>
G=$SP/adr/rtkreal; rm -rf $G; mkdir -p $G/repo/.state/rtk $G/repo/.claude $G/repo/ops/hooks $G/log; cd $G/repo; git init -q .; echo x>a.txt; git add a.txt
sed -e 's/^\[ "$mode" = "bypassPermissions" \] || exit 0$/echo "$mode" >> "$CLAUDE_PROJECT_DIR\/.state\/hook.log"/' -e 's#^pre="RTK_DB_PATH=$KB_RTK_STATE/history.db#pre="RTK_DB_PATH=$CLAUDE_PROJECT_DIR/.state/rtk/history.db#' $SP/adr/rtktest/guard.sh > ops/hooks/rtk-guard.sh
chmod +x ops/hooks/rtk-guard.sh
cat > .claude/settings.json <<'J'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/ops/hooks/rtk-guard.sh","timeout":10}]}]}}
J
sha256sum ~/.local/share/rtk/history.db | cut -c1-16 > $G/log/before; stat -c %Y ~/.local/share/rtk/history.db >> $G/log/before
env -i HOME="$HOME" PATH="/home/<user>/.local/bin:/home/<user>/.nvm/versions/node/v26.13.0/bin:/usr/bin:/bin" LANG=C.UTF-8 DISABLE_AUTOUPDATER=1 \
  timeout 90 /home/<user>/.local/bin/claude -p 'Run exactly this bash command once and report its output: git status' \
  --setting-sources project --strict-mcp-config --tools Bash --allowedTools Bash --model haiku --max-turns 3 --max-budget-usd 0.03 --no-session-persistence --output-format stream-json --verbose > $G/log/stream.jsonl 2> $G/log/err.txt
echo rc=$?
jq -r 'select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")|.input.command' $G/log/stream.jsonl | head
jq -r 'select(.type=="result")|[.subtype,.is_error,.total_cost_usd]|@tsv' $G/log/stream.jsonl
echo "hook.log:"; cat .state/hook.log 2>/dev/null
ls -la .state/rtk | awk '{print $5,$9}'
sha256sum ~/.local/share/rtk/history.db | cut -c1-16 > $G/log/after; stat -c %Y ~/.local/share/rtk/history.db >> $G/log/after
diff $G/log/before $G/log/after && echo "전역 history.db 불변"
head -c 300 $G/log/err.txt
