#!/usr/bin/env bash
# Print RSS (KiB) and thread count for a PID and its whole descendant tree.
# usage: sample.sh <pid>
root=$1
collect() { local p=$1; echo "$p"; for c in $(pgrep -P "$p" 2>/dev/null); do collect "$c"; done; }
total=0; n=0
for p in $(collect "$root"); do
  [ -r "/proc/$p/status" ] || continue
  rss=$(awk '/^VmRSS:/{print $2}' "/proc/$p/status")
  th=$(awk '/^Threads:/{print $2}' "/proc/$p/status")
  cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" | cut -c1-90)
  printf '  pid=%s rss_kb=%s threads=%s cmd=%s\n' "$p" "${rss:-0}" "${th:-0}" "$cmd"
  total=$((total + ${rss:-0})); n=$((n + 1))
done
echo "  TOTAL procs=$n rss_kb=$total rss_mb=$((total / 1024))"
