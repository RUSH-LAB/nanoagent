#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
.venv/bin/nanoagent plugin run \
    config=examples/arxiv_source/configs/step3_save_search_results.yaml \
    home=examples/arxiv_source/outputs/step3_save_search_results \
    "$@"
