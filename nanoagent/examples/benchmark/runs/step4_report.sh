#!/usr/bin/env bash
# The report of step 3's runs, by harness.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
rm -rf examples/benchmark/outputs/step4_report
.venv/bin/python \
    examples/benchmark/step4_report.py \
    config=examples/benchmark/configs/step4_report.yaml \
    home=examples/benchmark/outputs/step4_report \
    -- "$@"
