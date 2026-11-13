#!/usr/bin/env bash
# One run: one harness on one case. Name the case and the harness, then override any field of the
# config:
#   step2_single_run.sh city-weather-01 claude model=deepseek/deepseek-v4-flash-0731
# Its folder is outputs/step2_single_run/<case>/<harness>, replaced when run again.

set -euo pipefail

case="${1:?name the case, e.g. city-weather-01}"
harness="${2:?name the harness: nanoagent, claude, codex, hermes, pi or dsh}"
shift 2

root="$(git rev-parse --show-toplevel)"
# The keys (OPENROUTER_API_KEY, ...) come from the repository's git-ignored .env.
set -a
source "$root/.env"
set +a
cd "$root/nanoagent"
home="examples/benchmark/outputs/step2_single_run/$case/$harness"
rm -rf "$home"
.venv/bin/python \
    examples/benchmark/step2_single_run.py \
    config=examples/benchmark/configs/step2_single_run.yaml \
    home="$home" \
    -- case="$case" harness="$harness" "$@"
