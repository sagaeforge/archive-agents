#!/usr/bin/env bash
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.6}; }
cd $S/c1-agentgateway; $S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-timeout.yaml; up $((PB+3)) 0.2
$S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up $((PB+6)) 0.8
$S/harness/svc.sh start c2 $S/c2-fastmcp node gateway.mjs; up $((PB+4)) 0.4
MCP_USE_ANONYMIZED_TELEMETRY=false $S/harness/svc.sh start c3 $S/c3-mcpuse node gateway.mjs; up $((PB+5)) 0.5
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up $((PB+0)) 0.5
cd $S/harness
node hang.mjs agentgateway http://127.0.0.1:$((PB+3))/mcp legacy s1-spike-throwaway-key &
node hang.mjs 1mcp http://127.0.0.1:$((PB+6))/mcp modern - &
node hang.mjs fastmcp-ts http://127.0.0.1:$((PB+4))/mcp modern - &
node hang.mjs mcp-use http://127.0.0.1:$((PB+5))/mcp modern - &
node hang.mjs baseline http://127.0.0.1:$((PB+0))/mcp modern - &
wait
for n in ag c4 c2 c3 c5; do $S/harness/svc.sh stop $n; done
$S/harness/svc.sh stop alpha
