#!/usr/bin/env bash
F=/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/logs/bench.txt
for _ in $(seq 1 190); do grep -q '^done' "$F" && break; sleep 3; done
cut -c1-300 "$F"
