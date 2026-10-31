#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
export ALPHA_STATEFUL=1
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs
for i in $(seq 1 500); do ss -ltn | grep -qE '127.0.0.1:18150 ' && break; sleep 0.01; done; sleep 0.5
node $S/harness/lifecycle.mjs http://127.0.0.1:18150/mcp modern 2>&1 | grep -E 'open |HTTP upstream back|call alpha \[alpha back|tools/list \[alpha back|call alpha \[\+2|NEW session call alpha|call alpha \[\+0.3|call beta \[\+3|NEW session call beta' | cut -c1-140
$S/harness/svc.sh stop c5
unset ALPHA_STATEFUL
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs
for i in $(seq 1 500); do ss -ltn | grep -qE '127.0.0.1:18150 ' && break; sleep 0.01; done; sleep 0.5
echo "--- stateless regression"; node $S/harness/probe.mjs http://127.0.0.1:18150/mcp both --out $S/results/c5-baseline-v2.json 2>&1 | grep -E '^==|tools:|resources:|linkReadback' | cut -c1-140
$S/harness/svc.sh stop c5
