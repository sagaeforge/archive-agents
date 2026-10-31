#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.6}; }
cd $S/c1-agentgateway; $S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-timeout.yaml; up 18110 0.2
$S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up 18140 0.8
$S/harness/svc.sh start c2 $S/c2-fastmcp node gateway.mjs; up 18120 0.4
MCP_USE_ANONYMIZED_TELEMETRY=false $S/harness/svc.sh start c3 $S/c3-mcpuse node gateway.mjs; up 18130 0.5
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up 18150 0.5
cd $S/harness
node hang.mjs agentgateway http://127.0.0.1:18110/mcp legacy s1-spike-throwaway-key &
node hang.mjs 1mcp http://127.0.0.1:18140/mcp modern - &
node hang.mjs fastmcp-ts http://127.0.0.1:18120/mcp modern - &
node hang.mjs mcp-use http://127.0.0.1:18130/mcp modern - &
node hang.mjs baseline http://127.0.0.1:18150/mcp modern - &
wait
for n in ag c4 c2 c3 c5; do $S/harness/svc.sh stop $n; done
$S/harness/svc.sh stop alpha
