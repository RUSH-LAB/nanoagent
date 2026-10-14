#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/nanoagent plugin run \
    config=examples/arxiv_source/configs/step2_search_papers.yaml \
    home=examples/arxiv_source/outputs/step2_search_papers \
    "$@"
