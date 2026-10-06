#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# Interactive: one run with the harness the config selects. Step 1's config fits as it is.
.venv/bin/python \
    examples/chat_with_agent/step2_interactive_chat.py \
    config=examples/chat_with_agent/configs/step1_llm_inference_with_tools.yaml \
    home=examples/chat_with_agent/outputs/step2_interactive_chat/nanoagent
