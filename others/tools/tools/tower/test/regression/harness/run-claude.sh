#!/usr/bin/env bash
# One real Claude Code run through a logging tap.
# usage: run-claude.sh <name> <gatewayPort> <bearer|-> [promptfile]
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
NAME=$1; PORT=$2; BEARER=$3; PROMPT=${4:-$S/harness/prompt.txt}
OUT=$S/cc/$NAME; mkdir -p "$OUT"; cd "$OUT" || exit 1
TAP_PORT=$((PB+7))
if [ "$BEARER" = "-" ]; then HDR=''; else HDR=",\"headers\":{\"Authorization\":\"Bearer $BEARER\"}"; fi
cat > mcp.json <<EOF
{"mcpServers":{"gw":{"type":"http","url":"http://127.0.0.1:$TAP_PORT/mcp"$HDR}}}
EOF
rm -f tap.jsonl
"$S/harness/svc.sh" start tap "$OUT" node "$S/harness/tap.mjs" $TAP_PORT "$PORT" "$OUT/tap.jsonl"
for _ in $(seq 1 200); do ss -ltn | grep -q "127.0.0.1:$TAP_PORT" && break; sleep 0.01; done
: > "$S/logs/beta-spawn.log"
env -u CLAUDECODE -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -u CLAUDE_PID -u CLAUDE_CODE_ENTRYPOINT \
  timeout 240 /home/user/.local/bin/claude -p "$(cat "$PROMPT")" \
    --model "${CC_MODEL:-sonnet}" --effort low \
    --mcp-config "$OUT/mcp.json" --strict-mcp-config \
    --tools "ToolSearch,ListMcpResourcesTool,ReadMcpResourceTool" \
    --allowedTools "mcp__gw" "ToolSearch" "ListMcpResourcesTool" "ReadMcpResourceTool" \
    --setting-sources project --no-session-persistence --disable-slash-commands \
    --output-format stream-json --verbose --max-budget-usd "${CC_BUDGET:-0.40}" \
    --debug mcp --debug-file "$OUT/debug.log" \
    > out.jsonl 2> err.txt
echo "claude exit=$?"
sleep 0.3
cp "$S/logs/beta-spawn.log" "$OUT/beta-spawn.log"
"$S/harness/svc.sh" stop tap
node "$S/harness/ccsummary.mjs" "$OUT"
