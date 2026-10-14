#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/nanoagent plugin agent \
    config=examples/nasdaq_drawdown/configs/step1_list_weekly_fallers.yaml \
    home=examples/nasdaq_drawdown/outputs/step1_list_weekly_fallers \
    "$@"
