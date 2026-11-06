#!/usr/bin/env bash
# restic 0.19.1 공식 릴리스를 SHA256SUMS로 확인하고 $KB_TOOLCHAIN/bin/restic 에 둔다. 멱등이다.
# 사용: source ops/bin/env.sh && ops/restic/install-restic.sh
set -euo pipefail
VER=0.19.1
ARCH="${RESTIC_ARCH:-linux_amd64}"
TC="${KB_TOOLCHAIN:-${KB_HOME:-/home/user/sagae-kb-data}/runtime}"
BIN="$TC/bin/restic"
if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | grep -q "restic $VER "; then
  echo "restic $VER 이미 있음: $BIN"; exit 0
fi
command -v bunzip2 >/dev/null || { echo "bunzip2 필요" >&2; exit 2; }
W="$(mktemp -d "${KB_TMP:-$HOME/.cache/sagae-kb}/restic-dl.XXXXXX")"   # /tmp(tmpfs)를 쓰지 않는다
trap 'rm -rf "$W"' EXIT
base="https://github.com/restic/restic/releases/download/v$VER"
curl -fsSL -o "$W/SHA256SUMS" "$base/SHA256SUMS"
f="restic_${VER}_${ARCH}.bz2"
curl -fsSL -o "$W/$f" "$base/$f"
(cd "$W" && grep " $f\$" SHA256SUMS | sha256sum -c -)
mkdir -p "$TC/bin"
bunzip2 -c "$W/$f" > "$BIN.new"
chmod 755 "$BIN.new"
mv -f "$BIN.new" "$BIN"
"$BIN" version
