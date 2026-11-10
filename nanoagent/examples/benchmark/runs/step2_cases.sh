#!/usr/bin/env bash
# The cases, each one's answer pinned by its plugin's reference tool.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
rm -rf examples/benchmark/outputs/step2_cases
.venv/bin/python \
    examples/benchmark/step2_cases.py \
    config=examples/benchmark/configs/step2_cases.yaml \
    home=examples/benchmark/outputs/step2_cases \
    -- "$@"
