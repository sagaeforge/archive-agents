#!/usr/bin/env bash
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
EV=$S/logs/alpha-events.log; : > $EV
up() { for i in $(seq 1 500); do ss -ltn | grep -qE "127.0.0.1:$((PB+0)) " && break; sleep 0.01; done; sleep 0.5; }
echo "sha256 gateway.mjs: $(sha256sum $S/c5-baseline/gateway.mjs | cut -c1-16)  LOC: $(grep -cvE '^\s*(//.*)?$' $S/c5-baseline/gateway.mjs)"
ALPHA_EXTRA=1 ALPHA_EVENTS=$EV $S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
cp $S/c5-baseline/upstreams.orig.json $S/c5-baseline/upstreams.json
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up
cd $S/upstreams
echo "### relay + korean + mrtr"; timeout 40 node _relay.mjs http://127.0.0.1:$((PB+0))/mcp - short $EV 2>&1 | cut -c1-150
timeout 20 node _mrtr.mjs http://127.0.0.1:$((PB+0))/mcp - 2>&1 | cut -c1-120
timeout 115 node _relay.mjs http://127.0.0.1:$((PB+0))/mcp - long $EV 2>&1 | cut -c1-120
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
$S/harness/svc.sh stop c5; GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up
echo "### probe"; node $S/harness/probe.mjs http://127.0.0.1:$((PB+0))/mcp both --out $S/results/c5-baseline-final.json 2>&1 | grep -E '^==|instructions|tools:|resources:|linkReadback' | cut -c1-130
echo "### lifecycle modern"; node $S/harness/lifecycle.mjs http://127.0.0.1:$((PB+0))/mcp modern 2>&1 | grep -E 'alpha down\]|alpha back, same|\[\+3.3|NEW session call beta' | cut -c1-120
echo "### lifecycle legacy"; node $S/harness/lifecycle.mjs http://127.0.0.1:$((PB+0))/mcp legacy 2>&1 | grep -E 'tools/list \[alpha down|call beta \[\+3.3|NEW session call beta' | cut -c1-120
$S/harness/svc.sh stop c5
ALPHA_STATEFUL=1 $S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_RETRY_MS=200 $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up
echo "### session-based upstream"; ALPHA_STATEFUL=1 node $S/harness/lifecycle.mjs http://127.0.0.1:$((PB+0))/mcp modern 2>&1 | grep -E 'call alpha \[alpha back|NEW session call alpha' | cut -c1-120
$S/harness/svc.sh stop c5
$S/harness/svc.sh start alpha $S/upstreams node alpha.mjs; sleep 1
GW_TOKEN=s1-spike-throwaway-key $S/harness/svc.sh start c5 $S/c5-baseline node gateway.mjs; up
echo "### real Claude Code"; bash $S/harness/run-claude.sh base-final $((PB+0)) s1-spike-throwaway-key 2>&1 | grep -E '^claude_code|^init mcp|^tool_use (mcp|ReadMcp)|^result|^server/discover|^header|^requests still|^beta spawns' | cut -c1-260
$S/harness/svc.sh stop c5
