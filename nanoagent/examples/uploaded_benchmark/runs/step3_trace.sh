#!/usr/bin/env bash
# Step 3 (trace); settings come from configs/step3_trace.yaml, overrides after the script's arguments.
# RUSH_WORKSPACE_ID names the workspace, and RUSH_SESSION_TOKEN holds a Better Auth session token.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root/nanoagent"
.venv/bin/python \
    examples/uploaded_benchmark/step3_trace.py \
    config=examples/uploaded_benchmark/configs/step3_trace.yaml \
    home=examples/uploaded_benchmark/outputs/step3_trace \
    -- "$@"
