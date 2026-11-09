#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/agent_timing/step1_build_cases.py \
    config=examples/agent_timing/configs/step1_build_cases.yaml \
    home=examples/agent_timing/outputs/step1_build_cases
