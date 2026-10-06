#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
: "${MSA_ROOT:=/Users/yangdzey/Code/mind-sports-arena}"
: "${LOCALDB:=$MSA_ROOT/local/db}"
: "${CHROME_BIN:=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
export MSA_ROOT LOCALDB CHROME_BIN
.venv/bin/nanoagent plugin agent \
    config=examples/chess_move/configs/step1_play_move.yaml \
    home=examples/chess_move/outputs/step1_play_move \
    "$@"
