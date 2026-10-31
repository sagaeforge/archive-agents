#!/bin/sh
# Runs every project hook test. Tests skip themselves, with a reason, when what they
# need is not installed: jq or timeout for anything that expects hook output, and
# bwrap, Claude Code, rtk, or Trail-Code for full sessions.
exec node --test "$(dirname "$0")"/*.test.mjs
