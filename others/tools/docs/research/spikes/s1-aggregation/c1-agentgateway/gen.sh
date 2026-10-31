#!/usr/bin/env bash
# gen.sh <failureMode|none> <beta script> <prefixMode|none> <statefulMode|none> > config
S=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation
FM=$1; BETA=$2; PM=${3:-none}; SM=${4:-none}; TTL=${5:-none}
NODE=/home/user/.nvm/versions/node/v26.13.0/bin/node
HASH=$(printf '%s' s1-spike-throwaway-key | sha256sum | cut -d' ' -f1)
cat <<Y
config:
  adminAddr: "off"
  statsAddr: "off"
  readinessAddr: "off"
  storage: { mode: readOnly }
$( [ "$TTL" != none ] && echo "  mcp: { sessionTtl: $TTL }" )
gateways:
  default: { port: 18110, bindAddress: 127.0.0.1 }
routes:
- matches: [{ path: { pathPrefix: /mcp } }]
  policies:
    apiKey:
      mode: strict
      location: { header: { name: authorization, prefix: 'Bearer ' } }
      keys: [{ keyHash: 'sha256:$HASH' }]
  backends:
  - mcp:
      dnsRebindingProtection: true
$( [ "$FM" != none ] && echo "      failureMode: $FM" )
$( [ "$PM" != none ] && echo "      prefixMode: $PM" )
$( [ "$SM" != none ] && echo "      statefulMode: $SM" )
      targets:
      - name: alpha
        mcp: { host: http://127.0.0.1:18101/mcp }
      - name: beta
        stdio: { cmd: $NODE, args: [$S/upstreams/$BETA] }
Y
