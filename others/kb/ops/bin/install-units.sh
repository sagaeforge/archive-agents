#!/usr/bin/env bash
# 사용: install-units.sh [--apply] [--with-tcp]
# 기본은 건식 실행. 실행할 명령만 출력한다. --apply일 때만 실제로 바꾼다(사용자 결정 3 뒤).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$repo/ops/systemd"
dest="${KB_UNIT_DEST:-$HOME/.config/systemd/user}"
apply=0; tcp=0
for a in "$@"; do
  case "$a" in
    --apply) apply=1 ;;
    --with-tcp) tcp=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
units=(kb-tick.timer kb-tick.service kb-agent.timer kb-agent.service kb-read.socket kb-read.service)
[ "$tcp" = 1 ] && units+=(kb-read-tcp.socket)
run() {
  if [ "$apply" = 1 ]; then echo "+ $*"; "$@"; else echo "DRY: $*"; fi
}
[ "$apply" = 1 ] || echo "# 건식 실행. 실제 적용은 --apply (사용자 결정 3 뒤)"
run mkdir -p "$dest"
for u in "${units[@]}"; do run ln -sfn "$src/$u" "$dest/$u"; done
run systemctl --user daemon-reload
enable=(kb-tick.timer kb-agent.timer kb-read.socket)
[ "$tcp" = 1 ] && enable+=(kb-read-tcp.socket)
run systemctl --user enable --now "${enable[@]}"
run loginctl enable-linger "$(id -un)"
# Windows 작업: distro 이름은 설치 때 확인한다.
if command -v wsl.exe >/dev/null 2>&1; then
  if [ "$apply" = 1 ]; then
    distro="$(wsl.exe -l -q | tr -d '\r\0' | sed '/^$/d' | head -1)"
    [ -n "$distro" ] || { echo "wsl.exe -l -q: distro not found" >&2; exit 1; }
  else
    distro="<wsl.exe -l -q 결과>"
  fi
  xml="$repo/ops/windows/kb-tick.xml"
  run schtasks.exe /Create /TN kb-tick /XML "$(wslpath -w "$xml")" /F
  echo "# 작업 XML의 distro 이름 Ubuntu를 '$distro'로 맞출 것(설치 때 확인)"
else
  echo "DRY: schtasks.exe /Create /TN kb-tick /XML <ops/windows/kb-tick.xml> /F  (wsl.exe 없음)"
fi
