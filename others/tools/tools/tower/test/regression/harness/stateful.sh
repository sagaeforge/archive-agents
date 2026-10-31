#!/usr/bin/env bash
# Run the lifecycle against every candidate with a session-based alpha; keep only the alpha recovery lines.
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
export ALPHA_STATEFUL=1
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
filter() { grep -E 'open |HTTP upstream back|call alpha \[alpha back|call alpha \[\+2|NEW session call alpha|call alpha \[\+0.3|tools/list \[alpha back' | cut -c1-165; }
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.8}; }
run() { # name port era bearer
  echo "##### $1 $3"; if [ "$4" != "-" ]; then node $S/harness/lifecycle.mjs http://127.0.0.1:$2/mcp $3 --bearer $4 2>&1 | filter; else node $S/harness/lifecycle.mjs http://127.0.0.1:$2/mcp $3 2>&1 | filter; fi
}
cd $S/c1-agentgateway; cp cfg-fm-failOpen_beta.mjs.yaml cfg-run.yaml
$S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-run.yaml; up $((PB+3)) 0.3
run agentgateway $((PB+3)) legacy s1-spike-throwaway-key
run agentgateway $((PB+3)) modern s1-spike-throwaway-key
$S/harness/svc.sh stop ag
$S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up $((PB+6))
run 1mcp $((PB+6)) modern -
$S/harness/svc.sh stop c4
$S/harness/svc.sh start c2 $S/c2-fastmcp node gateway.mjs; up $((PB+4)) 0.4
run fastmcp $((PB+4)) modern -
$S/harness/svc.sh stop c2
MCP_USE_ANONYMIZED_TELEMETRY=false $S/harness/svc.sh start c3 $S/c3-mcpuse node gateway.mjs; up $((PB+5)) 0.5
run mcp-use $((PB+5)) modern -
$S/harness/svc.sh stop c3
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up $((PB+0)) 0.5
run baseline $((PB+0)) modern -
$S/harness/svc.sh stop c5
unset ALPHA_STATEFUL
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs
