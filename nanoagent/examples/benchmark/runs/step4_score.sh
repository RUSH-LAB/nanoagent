#!/usr/bin/env bash
# Every run of step 3 scored by its plugin's verifier, and summed up by harness.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
rm -rf examples/benchmark/outputs/step4_score
.venv/bin/python \
    examples/benchmark/step4_score.py \
    config=examples/benchmark/configs/step4_score.yaml \
    home=examples/benchmark/outputs/step4_score \
    -- "$@"
