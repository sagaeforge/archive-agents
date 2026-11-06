#!/bin/bash
# usage: cc.sh <label> <port> <tools> <allowed> <prompt>
. /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s2-lifecycle/lib.sh
L=$1; P=$2; T=$3; A=$4; PR=$5
cd $S/cc-cwd
t0=$(date +%s.%N)
timeout 240 $CLAUDE -p "$PR" --model haiku --mcp-config $S/mcp-$P.json --strict-mcp-config --no-session-persistence --disable-slash-commands --tools "$T" --allowedTools "$A" --output-format stream-json --verbose --debug=mcp --debug-file $S/out/cc-$L.debug < /dev/null > $S/out/cc-$L.jsonl 2> $S/out/cc-$L.err
rc=$?
t1=$(date +%s.%N)
python3 - "$S/out/cc-$L.jsonl" "$L" "$rc" "$t0" "$t1" <<'P'
import json,sys
f,L,rc,t0,t1=sys.argv[1:]
init=None;res=None;tools=[];trs=[]
for l in open(f):
    try:o=json.loads(l)
    except: continue
    if o.get('type')=='system' and o.get('subtype')=='init': init=o
    if o.get('type')=='result': res=o
    if o.get('type')=='assistant':
        for c in o['message'].get('content',[]):
            if c.get('type')=='tool_use': tools.append(c['name'])
    if o.get('type')=='user':
        c=o['message'].get('content',[])
        if isinstance(c,list):
            for x in c:
                if x.get('type')=='tool_result':
                    v=x.get('content'); v=v if isinstance(v,str) else json.dumps(v)
                    trs.append((bool(x.get('is_error')),v[:140]))
print(json.dumps({'label':L,'rc':int(rc),'wall_s':round(float(t1)-float(t0),1),'mcp_servers':init and init.get('mcp_servers'),'mcp_tools':[t for t in (init or {}).get('tools',[]) if 'mcp__' in t],'duration_ms':res and res.get('duration_ms'),'cost':res and res.get('total_cost_usd'),'model':(init or {}).get('model'),'tool_uses':tools,'tool_results':trs,'result':(res or {}).get('result','')[:300]}))
P
