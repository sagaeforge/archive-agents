#!/usr/bin/env bash
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
EV=$S/logs/alpha-events.log; : > $EV
ALPHA_EXTRA=1 ALPHA_EVENTS=$EV $S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.6}; }
cd $S/c1-agentgateway; cp cfg-fm-failOpen_beta.mjs.yaml cfg-run.yaml
$S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-run.yaml; up $((PB+3)) 0.2
$S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up $((PB+6)) 0.8
$S/harness/svc.sh start c2 $S/c2-fastmcp node gateway.mjs; up $((PB+4)) 0.4
MCP_USE_ANONYMIZED_TELEMETRY=false $S/harness/svc.sh start c3 $S/c3-mcpuse node gateway.mjs; up $((PB+5)) 0.5
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up $((PB+0)) 0.5
cd $S/upstreams
declare -A P=([agentgateway]=$((PB+3)) [1mcp]=$((PB+6)) [fastmcp]=$((PB+4)) [mcp-use]=$((PB+5)) [baseline]=$((PB+0)))
declare -A B=([agentgateway]=s1-spike-throwaway-key [1mcp]=- [fastmcp]=- [mcp-use]=- [baseline]=-)
for n in agentgateway 1mcp fastmcp mcp-use baseline; do
  echo "##### $n"; timeout 40 node _relay.mjs http://127.0.0.1:${P[$n]}/mcp ${B[$n]} short $EV 2>&1 | cut -c1-190
done
echo "##### 70 s call, all five at once"
for n in agentgateway 1mcp fastmcp mcp-use baseline; do
  ( echo "$n: $(timeout 115 node _relay.mjs http://127.0.0.1:${P[$n]}/mcp ${B[$n]} long $EV 2>&1 | cut -c1-170)" ) &
done
wait
for n in ag c4 c2 c3 c5; do $S/harness/svc.sh stop $n; done
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs
