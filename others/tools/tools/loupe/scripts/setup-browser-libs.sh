#!/bin/bash
# WSL lacks the shared libraries headless Chromium needs (libnspr4, libnss3, libasound). No root here: download the
# packages with apt-get (no install), unpack them under .cache/libs-x, and let scripts/e2e-headless.mjs add them to LD_LIBRARY_PATH.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .cache/debs && rm -rf .cache/libs-x
(cd .cache/debs && apt-get download libnspr4 libnss3 libasound2t64)
for d in .cache/debs/*.deb; do dpkg-deb -x "$d" .cache/libs-x; done
echo "unpacked into .cache/libs-x"
