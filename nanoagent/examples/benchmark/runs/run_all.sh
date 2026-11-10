#!/usr/bin/env bash
# The whole benchmark, every step in order: the plugins, the cases, every harness on every case,
# and the scores. The local RUSH database must be up (helpinghands' `npm run local`).

set -euo pipefail

runs="$(git rev-parse --show-toplevel)/nanoagent/examples/benchmark/runs"
bash "$runs/step1_plugins.sh"
bash "$runs/step2_cases.sh"
bash "$runs/step3_profile.sh"
bash "$runs/step4_score.sh"
