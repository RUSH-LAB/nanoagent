#!/usr/bin/env bash
# NanoAgent's model is on OpenRouter: OPENROUTER_API_KEY must be set. Claude Code uses its own login,
# or OpenRouter in same-model. Usage: step2_run_agents.sh out-of-box|same-model [key=value ...]
# Running it again resumes the run in that folder.

set -euo pipefail

run="${1:?name a run: out-of-box or same-model}"
shift
case "$run" in
    out-of-box) systems="[nanoagent,claude-code]" ;;
    same-model) systems="[nanoagent,claude-code-openrouter]" ;;
    *) echo "unknown run $run: out-of-box or same-model" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/agent_timing/step2_run_agents.py \
    config=examples/agent_timing/configs/step2_run_agents.yaml \
    home="examples/agent_timing/outputs/step2_run_agents/$run" \
    -- systems="$systems" "$@"
