#!/usr/bin/env bash
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs
for i in $(seq 1 500); do ss -ltn | grep -qE "127.0.0.1:$((PB+0)) " && break; sleep 0.01; done; sleep 0.5
cd $S/harness; timeout 100 node hang.mjs baseline http://127.0.0.1:$((PB+0))/mcp modern -
$S/harness/svc.sh stop c5
