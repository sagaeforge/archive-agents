#!/usr/bin/env bash
# Count real beta node processes, ignoring shells whose command line mentions the name.
ps -eo args | grep -E '^[^ ]*node .*beta(-legacy)?\.mjs' | grep -v grep | wc -l
