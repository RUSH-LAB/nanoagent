#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
.venv/bin/nanoagent plugin agent \
    config=examples/chess_move/configs/step1_play_move.yaml \
    home=examples/chess_move/outputs/step1_play_move \
    "$@"
