# source 전용. 툴체인과 데이터 경로 환경을 내보낸다. 셸 프로필, ~/.claude는 건드리지 않는다.
_kb_self="${BASH_SOURCE[0]:-${(%):-%x}}"
KB_REPO="$(cd "$(dirname "$_kb_self")/../.." && pwd)"
export KB_REPO
export KB_HOME="${KB_HOME:-/home/user/sagae-kb-data}"
export KB_TOOLCHAIN="${KB_TOOLCHAIN:-$KB_HOME/runtime}"
export UV_CACHE_DIR="$KB_TOOLCHAIN/uv-cache"
export UV_PYTHON_INSTALL_DIR="$KB_TOOLCHAIN/python"
export UV_PYTHON_DOWNLOADS=manual
export UV_PYTHON_PREFERENCE=only-managed
export UV_LINK_MODE=copy
export npm_config_cache="$KB_TOOLCHAIN/npm-cache"
export KB_MODELS="$KB_TOOLCHAIN/../models"
if [ -z "${KB_CLAUDE_BIN:-}" ]; then
  _kb_cl=""
  if [ -d "$HOME/.local/share/claude/versions" ]; then
    _kb_cl="$(ls -1 "$HOME/.local/share/claude/versions" 2>/dev/null | sort -V | tail -n1)"
  fi
  if [ -n "$_kb_cl" ] && [ -f "$HOME/.local/share/claude/versions/$_kb_cl" ]; then
    KB_CLAUDE_BIN="$HOME/.local/share/claude/versions/$_kb_cl"
  else
    KB_CLAUDE_BIN=""
  fi
  unset _kb_cl
fi
export KB_CLAUDE_BIN
case ":$PATH:" in *":$KB_TOOLCHAIN/uv:"*) ;; *) export PATH="$KB_TOOLCHAIN/uv:$PATH" ;; esac
unset _kb_self
