#!/usr/bin/env bash
# Run 1MCP with HOME redirected into the spike directory so nothing global is written.
export HOME=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/c4-1mcp/home XDG_CONFIG_HOME=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/c4-1mcp/home/.config DO_NOT_TRACK=1
exec node /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/c4-1mcp/node_modules/@1mcp/agent/build/index.js serve --config ${CFG:-/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/c4-1mcp/mcp.json} --transport http --host 127.0.0.1 --port ${GW_PORT:-18140} "$@"
