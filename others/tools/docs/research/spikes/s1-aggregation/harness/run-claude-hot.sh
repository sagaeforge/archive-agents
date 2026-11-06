#!/usr/bin/env bash
# Live hot add: one running Claude Code session, a new upstream added between two turns.
# usage: run-claude-hot.sh <name> <gatewayPort> <bearer|-> <reload shell command>
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
NAME=$1; PORT=$2; BEARER=$3; RELOAD=$4
OUT=$S/cc/$NAME; mkdir -p "$OUT"; cd "$OUT" || exit 1
TAP_PORT=18160
if [ "$BEARER" = "-" ]; then HDR=''; else HDR=",\"headers\":{\"Authorization\":\"Bearer $BEARER\"}"; fi
cat > mcp.json <<EOF
{"mcpServers":{"gw":{"type":"http","url":"http://127.0.0.1:$TAP_PORT/mcp"$HDR}}}
EOF
rm -f tap.jsonl in.fifo out.jsonl
mkfifo in.fifo
"$S/harness/svc.sh" start tap "$OUT" node "$S/harness/tap.mjs" $TAP_PORT "$PORT" "$OUT/tap.jsonl"
for _ in $(seq 1 200); do ss -ltn | grep -q "127.0.0.1:$TAP_PORT" && break; sleep 0.01; done
env -u CLAUDECODE -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -u CLAUDE_PID -u CLAUDE_CODE_ENTRYPOINT \
  timeout 120 /home/user/.local/bin/claude -p --input-format stream-json --output-format stream-json --verbose \
    --model sonnet --effort low --mcp-config "$OUT/mcp.json" --strict-mcp-config \
    --tools "ToolSearch" --allowedTools "mcp__gw" "ToolSearch" \
    --setting-sources project --no-session-persistence --disable-slash-commands --max-budget-usd 0.30 \
    --debug mcp --debug-file "$OUT/debug.log" < in.fifo > out.jsonl 2> err.txt &
CL=$!
exec 3> in.fifo
send() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":%s}]}}\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1")" >&3; }
waitresult() { local want=$1; for _ in $(seq 1 600); do [ "$(grep -c '"type":"result"' out.jsonl)" -ge "$want" ] && return 0; sleep 0.1; done; return 1; }
send 'Reply with the single word ready. Do not call any tool.'
waitresult 1; echo "turn 1 done"
eval "$RELOAD"
sleep ${HOT_WAIT:-4}
send 'Call ToolSearch with query "status_g". If a gw tool whose name ends in status_g exists, load and call it. Then state whether it existed and the exact names of all mcp__gw__ tools you know about.'
waitresult 2; echo "turn 2 done"
exec 3>&-
sleep 1
kill $CL 2>/dev/null; wait $CL 2>/dev/null
"$S/harness/svc.sh" stop tap
node - <<JS
const fs=require('fs');
const ev=fs.readFileSync('out.jsonl','utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const inits=ev.filter(e=>e.type==='system'&&e.subtype==='init');
console.log('init tool lists:',inits.map(i=>i.tools.filter(t=>t.startsWith('mcp__')).length).join(','));
for(const e of ev)for(const c of e.message?.content??[]){
  if(c.type==='tool_use')console.log('tool_use',c.name,JSON.stringify(c.input).slice(0,80));
  if(c.type==='tool_result')console.log('  result',(typeof c.content==='string'?c.content:JSON.stringify(c.content)).slice(0,170));
}
const res=ev.filter(e=>e.type==='result');
console.log('final:',(res.at(-1)?.result??'').slice(0,420).replace(/\n/g,' '));
console.log('cost',res.at(-1)?.total_cost_usd);
const tap=fs.readFileSync('tap.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const started=tap.filter(r=>r.started).map(r=>(r.http==='POST'?'':r.http+' ')+(r.method??r.hdrMethod??''));
console.log('wire starts:',started.join(' | ').slice(0,700));
JS
grep -n -iE 'list_changed|listChanged|tools changed|refresh' "$OUT/debug.log" | cut -c1-170 | head -6
