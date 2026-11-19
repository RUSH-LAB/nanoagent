#!/usr/bin/env bash
# Step 5 (results); settings come from configs/step5_results.yaml, overrides after the script's arguments.
# RUSH_WORKSPACE_ID names the workspace, and RUSH_SESSION_TOKEN holds a Better Auth session token.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root/nanoagent"
.venv/bin/python \
    examples/uploaded_benchmark/step5_results.py \
    config=examples/uploaded_benchmark/configs/step5_results.yaml \
    home=examples/uploaded_benchmark/outputs/step5_results \
    -- "$@"
