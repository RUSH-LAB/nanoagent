#!/usr/bin/env bash
# Step 3's runs kept in the local RUSH, as scored runs of its reference harnesses.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/benchmark/step5_import_runs.py \
    config=examples/benchmark/configs/step5_import_runs.yaml \
    home=examples/benchmark/outputs/step5_import_runs \
    -- "$@"
