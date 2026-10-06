#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
.venv/bin/python \
    examples/chat_with_agent/step1_llm_inference_with_tools.py \
    config=examples/chat_with_agent/configs/step1_llm_inference_with_tools.yaml \
    home=examples/chat_with_agent/outputs/step1_llm_inference_with_tools/nanoagent
