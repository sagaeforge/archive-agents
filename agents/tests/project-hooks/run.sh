#!/bin/sh
# Runs every project hook test. Session tests skip themselves, with a reason, when
# bwrap, Claude Code, rtk, or Trail-Code are not installed.
exec node --test "$(dirname "$0")"/*.test.mjs
