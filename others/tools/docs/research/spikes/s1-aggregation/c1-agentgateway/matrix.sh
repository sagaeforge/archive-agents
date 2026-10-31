#!/usr/bin/env bash
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
cd $S/c1-agentgateway
for combo in "none beta.mjs" "failOpen beta.mjs" "none beta-legacy.mjs" "failOpen beta-legacy.mjs"; do
  set -- $combo
  tag="fm-$1_$2"
  bash gen.sh $1 $2 > cfg-$tag.yaml
  $S/harness/svc.sh stop ag
  $S/harness/svc.sh start ag $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-$tag.yaml
  for i in $(seq 1 300); do ss -ltn | grep -q '127.0.0.1:18110' && break; sleep 0.01; done
  echo "################ $tag"
  : > $S/logs/beta-spawn.log
  node $S/harness/probe.mjs http://127.0.0.1:18110/mcp both --bearer s1-spike-throwaway-key --out $S/results/c1-$tag.json 2>&1 | cut -c1-200 | grep -vE '^   (prompts|read|linkReadback)'
  echo "   spawns during probe: $(grep -c '"spawn"' $S/logs/beta-spawn.log)  exits: $(grep -c '"exit"' $S/logs/beta-spawn.log)"
  bash $S/harness/spawncount.sh http://127.0.0.1:18110/mcp s1-spike-throwaway-key "server/discover" "tools/list" "tools/call alpha_status" "tools/call beta_status" 2>&1 | cut -c1-150
done
$S/harness/svc.sh stop ag
sleep 0.5; echo "live beta after stop: $(pgrep -f '[u]pstreams/beta' | wc -l)"
