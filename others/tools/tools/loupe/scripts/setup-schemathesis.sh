#!/bin/bash
# Creates .cache/st-venv with Schemathesis 4.32.7. The venv has no pip of its own; the system pip installs into it.
set -eu
cd "$(dirname "$0")/.."
rm -rf .cache/st-venv
python3 -m venv --without-pip .cache/st-venv
python3 -m pip --python .cache/st-venv/bin/python install --disable-pip-version-check schemathesis==4.32.7
.cache/st-venv/bin/st --version
