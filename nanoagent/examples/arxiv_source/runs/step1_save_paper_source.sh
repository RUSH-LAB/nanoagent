#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
.venv/bin/nanoagent plugin run \
    config=examples/arxiv_source/configs/step1_save_paper_source.yaml \
    home=examples/arxiv_source/outputs/step1_save_paper_source \
    "$@"
