#!/usr/bin/env bash
# 유닛을 $KB_TMP에 복사하고 ExecStart 실행 파일만 /bin/true로 바꿔 systemd-analyze --user verify.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="${KB_TMP:-${KB_BUILD_ROOT:-$HOME/.cache/sagae-kb/build}/WP-14/test-tmp/WP-14}/units-verify"
rm -rf "$tmp"; mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
for f in kb-tick.timer kb-tick.service kb-agent.timer kb-agent.service kb-read.socket kb-read-tcp.socket kb-read.service; do
  sed -E 's#^ExecStart=[^ ]+#ExecStart=/bin/true#' "$repo/ops/systemd/$f" > "$tmp/$f"
done
cd "$tmp"
systemd-analyze --user verify "$tmp"/kb-*.timer "$tmp"/kb-*.service "$tmp"/kb-*.socket
echo "verify ok"
