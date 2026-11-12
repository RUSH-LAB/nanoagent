#!/usr/bin/env bash
# Make one benchmark case for every benchmarkable plugin task without a cases file, writing each to
# examples/benchmark/configs/step1_<name>_cases.json. Override any field of the config, e.g.
#   step1_make_cases.sh only=[bill-split]

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# OPENROUTER_API_KEY comes from the repository's git-ignored .env.
set -a
source "$root/.env"
set +a
cd "$root/nanoagent"
home="examples/benchmark_cases/outputs/step1_make_cases"
rm -rf "$home"
.venv/bin/python \
    examples/benchmark_cases/step1_make_cases.py \
    config=examples/benchmark_cases/configs/step1_make_cases.yaml \
    home="$home" \
    -- "$@"
