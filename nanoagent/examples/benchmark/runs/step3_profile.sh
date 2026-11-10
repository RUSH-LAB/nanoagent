#!/usr/bin/env bash
# Every harness run once on every case of step 2, each run in its own folder, <case>/<harness>.
# Overrides go to every run (e.g. model=...). A run that fails keeps its profile and counts as wrong
# in step 4; a run that writes no profile stops the sweep.

set -euo pipefail

harnesses=(nanoagent claude codex hermes pi dsh)

root="$(git rev-parse --show-toplevel)"
# The keys (OPENROUTER_API_KEY, ...) come from the repository's git-ignored .env.
set -a
source "$root/.env"
set +a
cd "$root/nanoagent"
outputs=examples/benchmark/outputs/step3_profile
cases=$(.venv/bin/python -c 'import json, sys; print(" ".join(case["id"] for case in json.load(open(sys.argv[1]))["cases"]))' \
    examples/benchmark/outputs/step2_cases/cases.json)
rm -rf "$outputs"
for case in $cases; do
    for harness in "${harnesses[@]}"; do
        folder="$outputs/$case/$harness"
        .venv/bin/python \
            examples/benchmark/step3_profile.py \
            config=examples/benchmark/configs/step3_profile.yaml \
            home="$folder" \
            -- case="$case" harness="$harness" "$@" || true
        if [[ ! -f "$folder/profile.json" ]]; then
            echo "$harness on $case wrote no profile: see $folder/run.log" >&2
            exit 1
        fi
    done
done
