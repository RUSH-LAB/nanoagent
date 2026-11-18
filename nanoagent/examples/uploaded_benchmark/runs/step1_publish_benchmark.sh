#!/usr/bin/env bash
# Step 1 (publish_benchmark); settings come from configs/step1_publish_benchmark.yaml, overrides after the script's arguments.
# RUSH_WORKSPACE_ID names the workspace, and RUSH_SESSION_TOKEN holds a Better Auth session token.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root/nanoagent"
.venv/bin/python \
    examples/uploaded_benchmark/step1_publish_benchmark.py \
    config=examples/uploaded_benchmark/configs/step1_publish_benchmark.yaml \
    home=examples/uploaded_benchmark/outputs/step1_publish_benchmark \
    -- "$@"
