#!/usr/bin/env bash
# Every harness on every case, side by side (step 1 once per run), each run in its own folder.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# The keys (OPENROUTER_API_KEY, ...) come from the repository's git-ignored .env; every run gets them.
set -a
source "$root/.env"
set +a
cd "$root/nanoagent"
rm -rf examples/benchmark/outputs/step2_batch_runs
.venv/bin/python \
    examples/benchmark/step2_batch_runs.py \
    config=examples/benchmark/configs/step2_batch_runs.yaml \
    home=examples/benchmark/outputs/step2_batch_runs \
    -- "$@"
