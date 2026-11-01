#!/usr/bin/env bash
# uv 0.13.6과 CPython 3.14.10을 $KB_TOOLCHAIN 아래에 설치한다. 전역 파일은 건드리지 않는다.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/env.sh"
UV_VER=0.13.6
PY_VER=3.14.10
mkdir -p "$KB_TOOLCHAIN"
if [ -x "$KB_TOOLCHAIN/uv/uv" ] && [ "$("$KB_TOOLCHAIN/uv/uv" --version | cut -d' ' -f2)" = "$UV_VER" ]; then
  echo "uv $UV_VER 이미 설치됨"
else
  tmp="$(mktemp -d -p "$KB_TOOLCHAIN" .bootstrap.XXXXXX)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/install.sh" "https://astral.sh/uv/$UV_VER/install.sh"
  want="$(cut -d' ' -f1 "$here/uv-install.sha256")"
  got="$(sha256sum "$tmp/install.sh" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "install.sh sha256 불일치: $got" >&2; exit 3; }
  mkdir -p "$KB_TOOLCHAIN/uv"
  UV_UNMANAGED_INSTALL="$KB_TOOLCHAIN/uv" sh "$tmp/install.sh"
fi
"$KB_TOOLCHAIN/uv/uv" python install "$PY_VER" --no-bin --install-dir "$KB_TOOLCHAIN/python"
echo "bootstrap 완료: $("$KB_TOOLCHAIN/uv/uv" --version)"
