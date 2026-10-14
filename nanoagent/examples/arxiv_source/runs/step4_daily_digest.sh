#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/nanoagent plugin agent \
    config=examples/arxiv_source/configs/step4_daily_digest.yaml \
    home=examples/arxiv_source/outputs/step4_daily_digest \
    "$@"
