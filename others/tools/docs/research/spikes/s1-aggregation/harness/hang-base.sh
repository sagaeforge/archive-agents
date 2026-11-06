#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs
for i in $(seq 1 500); do ss -ltn | grep -qE '127.0.0.1:18150 ' && break; sleep 0.01; done; sleep 0.5
cd $S/harness; timeout 100 node hang.mjs baseline http://127.0.0.1:18150/mcp modern -
$S/harness/svc.sh stop c5
