#!/usr/bin/env bash
# Long TTL check on port 18111: sessionTtl 6 s, one idle legacy session, sample children every 5 s for 200 s.
S=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PB=${TOWER_TEST_PORT_BASE:-4890}
cd $S/c1-agentgateway
$S/harness/svc.sh start agttl $S/c1-agentgateway ./bin/agentgateway-linux-amd64 -f cfg-ttl2.yaml
for i in $(seq 1 300); do ss -ltn | grep -q "127.0.0.1:$((PB+3))" && break; sleep 0.01; done
P=$(cat $S/run/agttl.pid)
cat > $S/harness/_ttlopen.mjs <<'J'
import { open, outcome } from './lib.mjs';
const url=`http://127.0.0.1:${Number(process.env.TOWER_TEST_PORT_BASE ?? 4890) + 3}/mcp`, bearer='s1-spike-throwaway-key';
const s=await open(url,'legacy',bearer);
console.log('session',s.session?.slice(0,12), outcome(await s.call('tools/list')));
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({session:s.session, v:s.negotiated}));
J
node $S/harness/_ttlopen.mjs $S/results/ttl-session.json
t0=$(date +%s)
for i in $(seq 1 40); do
  n=$(pgrep -P $P | wc -l); now=$(( $(date +%s)-t0 ))
  echo "t=$now children=$n"
  [ "$n" = 0 ] && break
  sleep 5
done
SID=$(node -e "console.log(require('$S/results/ttl-session.json').session)")
echo "reuse after: $(curl -s -m 5 -w ' http=%{http_code}" -X POST http://127.0.0.1:$((PB+3))/mcp -H "authorization: Bearer s1-spike-throwaway-key' -H "mcp-session-id: $SID" -H 'mcp-protocol-version: 2025-11-25' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}' | cut -c1-170)"
$S/harness/svc.sh stop agttl
