#!/usr/bin/env bash
# The report of step 2's runs, by harness.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
rm -rf examples/benchmark/outputs/step3_get_report_from_db
.venv/bin/python \
    examples/benchmark/step3_get_report_from_db.py \
    config=examples/benchmark/configs/step3_get_report_from_db.yaml \
    home=examples/benchmark/outputs/step3_get_report_from_db \
    -- "$@"
