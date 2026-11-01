#!/usr/bin/env bash
# uv.lock의 고정 판을 해시 확인과 함께 $WHEELS_DIR(기본 $KB_HOME/runtime/wheels)에 내려받는다(T1 공급망, ADR 17.5).
# 환경 복원 때 `uv sync --frozen --offline`이 이 폴더를 find-links로 쓴다. 전역 설치는 하지 않는다(uvx는 임시 환경).
# 사용: source ops/bin/env.sh && ops/restic/build-wheelhouse.sh [--check]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
WH="${WHEELS_DIR:-${KB_HOME:-/home/user/sagae-kb-data}/runtime/wheels}"
mkdir -p "$WH"
req="$WH/.requirements.txt"
(cd "$repo" && uv export --frozen --no-emit-project --extra serve --extra collect --format requirements-txt -o "$req" >/dev/null)
if [ "${1:-}" = "--check" ]; then
  # 이 플랫폼에 필요한 요구(환경 표식 평가)마다 휠이나 sdist가 있는지 본다.
  "$repo/ops/bin/dev" python - "$req" "$WH" <<'PY'
import re, sys
from pathlib import Path
from packaging.requirements import Requirement
req, wh = sys.argv[1], Path(sys.argv[2])
have = [p.name.lower().replace("_", "-") for p in wh.iterdir() if p.suffix in (".whl", ".gz")]
need = missing = 0
for line in Path(req).read_text().splitlines():
    if not line or line[0] in " #-":
        continue
    r = Requirement(line.split(" \\")[0])
    if r.marker is not None and not r.marker.evaluate():
        continue
    need += 1
    ver = next(iter(r.specifier)).version
    pre = r.name.lower().replace("_", "-") + "-" + ver
    if not any(h.startswith(pre.replace("_", "-") + "-") or h.startswith(pre + ".") for h in have):
        missing += 1
        print("없음:", pre)
print(f"요구 {need}개, 없음 {missing}개: {wh}")
sys.exit(1 if missing else 0)
PY
  exit $?
fi
# --no-deps: 잠금 파일이 전이 의존까지 고정한다. --require-hashes: 잠금의 해시와 다르면 실패한다.
uvx pip download --quiet --no-deps --require-hashes -r "$req" -d "$WH"
find "$WH" -maxdepth 1 \( -name '*.whl' -o -name '*.tar.gz' \) | wc -l | sed 's/^/받은 파일: /'
