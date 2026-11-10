#!/usr/bin/env bash
# The plugins, unpacked from the local RUSH database's marketplace (helpinghands' `npm run local`).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
rm -rf examples/benchmark/outputs/step1_plugins
.venv/bin/python \
    examples/benchmark/step1_plugins.py \
    config=examples/benchmark/configs/step1_plugins.yaml \
    home=examples/benchmark/outputs/step1_plugins \
    -- "$@"
