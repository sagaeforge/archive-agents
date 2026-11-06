#!/usr/bin/env bash
# 사용: bash tests/contract_draft/orval-check.sh <openapi.yaml>
# $KB_TMP/orval에 orval 8.46.0 등을 --ignore-scripts로 깔고 loupe와 같은 설정으로 생성한 뒤 tsc로 검사한다.
set -euo pipefail
spec="$(cd "$(dirname "${1:?usage: orval-check.sh <spec>}")" && pwd)/$(basename "$1")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${KB_TMP:?KB_TMP가 필요하다(source ops/bin/wp-env.sh WP-23)}"
. "$repo/ops/bin/env.sh"
work="$KB_TMP/orval"
mkdir -p "$work"
cd "$work"
if [ ! -x node_modules/.bin/orval ] || [ ! -x node_modules/.bin/tsc ]; then
  [ -f package.json ] || echo '{"name":"kb-orval-check","private":true,"type":"module"}' > package.json
  npm install --ignore-scripts --no-audit --no-fund --save-exact \
    orval@8.46.0 typescript@5.9.3 @tanstack/react-query@5.104.5 @types/react@19.2.2 react@19.2.0 >/dev/null
fi
v="$(node_modules/.bin/orval --version)"
[ "$v" = "8.46.0" ] || { echo "orval 판 불일치: $v" >&2; exit 1; }
rm -rf gen src
mkdir -p gen
cp "$here/orval.config.mjs" "$here/kb-fetch.ts" "$here/narrow.ts" "$here/tsconfig.json" .
KB_SPEC="$spec" KB_GEN="$work/gen" node_modules/.bin/orval --config ./orval.config.mjs
# Orval은 tsconfig.json을 못 찾으면 확장자 없는 import를 내서 nodenext에서 깨진다. 위에서 복사한 파일이 이를 막는다.
node_modules/.bin/tsc -p tsconfig.json
unk="$(grep -rn 'data: unknown' gen || true)"
if [ -n "$unk" ]; then echo "data: unknown 발견:" >&2; echo "$unk" >&2; exit 1; fi
grep -q "SearchHit" gen/model/searchHit.ts
echo "orval-check OK: orval $v, tsc 오류 0, data: unknown 0건, narrow.ts 통과"
