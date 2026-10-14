#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/nanoagent plugin agent \
    config=examples/bibtex_check/configs/step1_check_bibtex.yaml \
    home=examples/bibtex_check/outputs/step1_check_bibtex \
    "$@"
