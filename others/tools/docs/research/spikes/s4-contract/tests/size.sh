#!/bin/bash
# fresh install per route, toolchain only plus the project's own typescript 5.9.3, then audit
cd "$1"
declare -A R
R[orval]="orval@8.46.0"
R[heyapi]="@hey-api/openapi-ts@0.99.0"
R[kubb]="kubb@5.15.3 @kubb/plugin-ts@5.4.0 @kubb/plugin-fetch@5.11.0 @kubb/plugin-react-query@5.8.0 @tanstack/react-query@5.105.0"
R[kubb-types]="kubb@5.15.3 @kubb/plugin-ts@5.4.0"
R[oatf]="openapi-typescript@7.13.0"
R[jstt]="json-schema-to-typescript@16.0.0"
for c in orval heyapi kubb kubb-types oatf jstt; do
  rm -rf size/$c; mkdir -p size/$c; cd size/$c; npm init -y >/dev/null
  npm i -E -D --ignore-scripts --no-fund --no-audit typescript@5.9.3 ${R[$c]} >/dev/null 2>&1
  tot=$(du -sm node_modules | cut -f1); ts=$(du -sm node_modules/typescript | cut -f1)
  pk=$(npm ls --all --parseable 2>/dev/null | sort -u | wc -l)
  npm audit --json > audit.json 2>/dev/null
  au=$(node -e "const a=JSON.parse(require('fs').readFileSync('audit.json'));const m=a.metadata.vulnerabilities;console.log('crit',m.critical,'high',m.high,'mod',m.moderate,'low',m.low)")
  nested=$(find node_modules -type d -path '*/typescript/lib' | wc -l)
  echo "$c: ${tot} MB total, ${ts} MB root typescript, pkgs $pk, typescript copies $nested, audit: $au"
  cd ../..
done
