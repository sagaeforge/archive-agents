#!/usr/bin/env bash
F=${TOWER_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/logs/bench.txt
for _ in $(seq 1 190); do grep -q '^done' "$F" && break; sleep 3; done
cut -c1-300 "$F"
