#!/usr/bin/env bash
# Step 4 (compare); settings come from configs/step4_compare.yaml, overrides after the script's arguments.
# RUSH_WORKSPACE_ID names the workspace, and RUSH_SESSION_TOKEN holds a Better Auth session token.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root/nanoagent"
.venv/bin/python \
    examples/uploaded_benchmark/step4_compare.py \
    config=examples/uploaded_benchmark/configs/step4_compare.yaml \
    home=examples/uploaded_benchmark/outputs/step4_compare \
    -- "$@"
