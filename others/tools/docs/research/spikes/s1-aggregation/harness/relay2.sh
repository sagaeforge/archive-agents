#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
EV=$S/logs/alpha-events.log; : > $EV
ALPHA_EXTRA=1 ALPHA_EVENTS=$EV $S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.6}; }
cd $S/c1-agentgateway
python3 - <<PY
s=open('cfg-fm-failOpen_beta.mjs.yaml').read()
s=s.replace("  policies:\n    apiKey:","  policies:\n    timeout: { backendRequestTimeout: 1800s }\n    apiKey:")
open('cfg-timeout.yaml','w').write(s)
PY
./bin/agentgateway-linux-amd64 -f cfg-timeout.yaml --validate-only 2>&1 | tail -1 | cut -c1-200
$S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-timeout.yaml; up 18110 0.2
cd $S/c4-1mcp
node -e "const j=require('./mcp.orig.json');j.mcpServers.alpha.requestTimeout=1800000;j.mcpServers.beta.requestTimeout=1800000;require('fs').writeFileSync('mcp.timeout.json',JSON.stringify(j,null,2))"
CFG=$S/c4-1mcp/mcp.timeout.json $S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up 18140 0.8
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up 18150 0.5
cd $S/upstreams
declare -A P=([agentgateway]=18110 [1mcp]=18140 [baseline]=18150)
declare -A B=([agentgateway]=s1-spike-throwaway-key [1mcp]=- [baseline]=-)
for n in agentgateway 1mcp baseline; do
  echo "##### $n"; timeout 40 node _relay.mjs http://127.0.0.1:${P[$n]}/mcp ${B[$n]} short $EV 2>&1 | grep korean | cut -c1-190
done
echo "##### 70 s call with explicit timeouts"
for n in agentgateway 1mcp; do
  ( echo "$n: $(timeout 115 node _relay.mjs http://127.0.0.1:${P[$n]}/mcp ${B[$n]} long $EV 2>&1 | cut -c1-170)" ) &
done
wait
for n in ag c4 c5; do $S/harness/svc.sh stop $n; done
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs
