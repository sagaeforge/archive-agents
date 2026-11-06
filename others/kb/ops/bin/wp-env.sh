# source ops/bin/wp-env.sh WP-nn [--live]
# 패키지별 빌드 변수를 내보낸다. 실운영 패키지는 실운영 값을 내보낸다.
_wp="${1:-}"
[ -n "$_wp" ] || { echo "usage: source wp-env.sh WP-nn [--live]" >&2; return 2 2>/dev/null || exit 2; }
_self="${BASH_SOURCE[0]:-${(%):-%x}}"
_dir="$(cd "$(dirname "$_self")" && pwd)"
export KB_BUILD_ROOT="${KB_BUILD_ROOT:-$HOME/.cache/sagae-kb/build}"
export KB_WP="$_wp"
_live=0
case "$_wp" in WP-21|WP-25|WP-26) _live=1 ;; esac
[ "$_wp" = "WP-14" ] && [ "${2:-}" = "--live" ] && _live=1
if [ "$_live" = 1 ]; then
  export KB_HOME=/home/user/sagae-kb-data
  export KB_LIVE=1
  export KB_CONFIG_DIR="$HOME/.config/sagae-kb"
else
  unset KB_LIVE
  export KB_HOME="$KB_BUILD_ROOT/$_wp"
  export KB_CONFIG_DIR="$KB_HOME/config"
fi
export KB_TMP="$KB_HOME/test-tmp/$_wp"
export KB_TOOLCHAIN=/home/user/sagae-kb-data/runtime
mkdir -p "$KB_TMP" 2>/dev/null
. "$_dir/env.sh"
unset _wp _self _dir _live
