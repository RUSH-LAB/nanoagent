#!/usr/bin/env bash
# Step 2 (submit_run); settings come from configs/step2_submit_run.yaml, overrides after the script's arguments.
# RUSH_WORKSPACE_ID names the workspace, and RUSH_SESSION_TOKEN holds a Better Auth session token.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root/nanoagent"
.venv/bin/python \
    examples/uploaded_benchmark/step2_submit_run.py \
    config=examples/uploaded_benchmark/configs/step2_submit_run.yaml \
    home=examples/uploaded_benchmark/outputs/step2_submit_run \
    -- "$@"
