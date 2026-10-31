#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
ALPHA_EXTRA=1 $S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
up() { for i in $(seq 1 1200); do ss -ltn | grep -qE "127.0.0.1:$1 " && break; sleep 0.01; done; sleep ${2:-0.6}; }
cd $S/upstreams; echo "control (direct alpha): $(timeout 20 node _mrtr.mjs http://127.0.0.1:18101/mcp - 2>&1 | cut -c1-190)"
cd $S/c1-agentgateway
$S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-timeout.yaml; up 18110 0.2
$S/harness/svc.sh start c4 $S/c4-1mcp ./run.sh; up 18140 0.8
$S/harness/svc.sh start c2 $S/c2-fastmcp node gateway.mjs; up 18120 0.4
MCP_USE_ANONYMIZED_TELEMETRY=false $S/harness/svc.sh start c3 $S/c3-mcpuse node gateway.mjs; up 18130 0.5
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up 18150 0.5
cd $S/upstreams
echo "agentgateway: $(timeout 20 node _mrtr.mjs http://127.0.0.1:18110/mcp s1-spike-throwaway-key 2>&1 | cut -c1-190)"
echo "1mcp:         $(timeout 20 node _mrtr.mjs http://127.0.0.1:18140/mcp - 2>&1 | cut -c1-190)"
echo "fastmcp:      $(timeout 20 node _mrtr.mjs http://127.0.0.1:18120/mcp - 2>&1 | cut -c1-190)"
echo "mcp-use:      $(timeout 20 node _mrtr.mjs http://127.0.0.1:18130/mcp - 2>&1 | cut -c1-190)"
echo "baseline:     $(timeout 20 node _mrtr.mjs http://127.0.0.1:18150/mcp - 2>&1 | cut -c1-190)"
echo "##### gateway SIGKILL: does a stdio child outlive it?"
for n in ag c4 c2 c3 c5; do
  P=$(cat $S/run/$n.pid); C=$(pgrep -P $P | wc -l)
  kill -9 $P; sleep 0.8
  echo "$n: children before=$C; live beta total after SIGKILL=$($S/harness/livebeta.sh)"
  rm -f $S/run/$n.pid
done
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs
