#!/usr/bin/env bash
# Scores one run of step 2. Usage: step3_score.sh out-of-box|same-model

set -euo pipefail

run="${1:?name a run of step 2: out-of-box or same-model}"

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/agent_timing/step3_score.py \
    config=examples/agent_timing/configs/step3_score.yaml \
    home="examples/agent_timing/outputs/step3_score/$run" \
    -- attempts="examples/agent_timing/outputs/step2_run_agents/$run"
