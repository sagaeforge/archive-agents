#!/bin/bash
# End-to-end proof. Usage: bash run-e2e.sh  (from the spike directory)
set -u
cd "$(dirname "$0")"; ROOT=$PWD; PORT=18401; TS7=$ROOT/gen7/orval/node_modules/.bin/tsc
export SCHEMATHESIS_TELEMETRY=false
if ss -ltn | grep -q ":$PORT "; then echo "port $PORT busy"; exit 9; fi
cd e2e
echo "[1] fixtures vs contract (ajv 8.20.0)"; node --no-warnings src/validate-fixtures.ts || exit 1
echo "[2] generate client (orval 8.46.0)"; rm -rf src/client; npx orval --config orval.config.mjs >/dev/null 2>&1; echo "rc=$?"
echo "[3] typecheck"; npx tsc -p . --pretty false; echo "tsc 5.9.3 rc=$?"; $TS7 -p . --pretty false; echo "tsc 7.0.2 rc=$?"
echo "[4] start kb-mock"; rm -f ../logs/access.log
KB_ACCESS_LOG=$ROOT/logs/access.log PORT=$PORT nohup node --no-warnings src/mock.ts > ../logs/mock.log 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null' EXIT; sleep 1.5; cat ../logs/mock.log
echo "[5] typed client"; ../gen/orval/node_modules/.bin/esbuild src/client-e2e.ts --bundle --platform=node --format=esm --outfile=../build/client-e2e.mjs --log-level=error --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
node ../build/client-e2e.mjs | tail -1
cd "$ROOT"
echo "[6] schemathesis 4.32.7"
for s in 1 2 3 4 5; do st-venv/bin/st --config-file schemathesis.toml run contract/openapi.yaml --url http://127.0.0.1:$PORT --checks all --seed $s --max-examples 100 --no-color > logs/st-final-$s.txt 2>&1; echo "seed $s rc=$? $(grep -E 'generated' logs/st-final-$s.txt | tr -s ' ') warnings=$(grep -c 'Missing test data' logs/st-final-$s.txt)"; done
echo "[7] status mix over all seeds (GET only)"; awk '$1=="GET"{print $2, $3}' logs/access.log | sort | uniq -c | awk '{print "  "$0}'
echo "5xx: $(grep -cE ' 5[0-9][0-9]$' logs/access.log)"
