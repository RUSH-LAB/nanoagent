#!/usr/bin/env bash
# Convert the old-shape cases files of the plugins in plugin-cases/verified/selection.json into the new shape, writing
# plugin-cases/verified/<plugin>.yaml, its fixtures and report.json. Nothing is published.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# The psql the config names: Homebrew's keg-only postgresql@18, wherever Homebrew lives.
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"
cd "$root/nanoagent"
home="examples/benchmark/outputs/step1_convert_cases"
rm -rf "$home"
.venv/bin/python \
    examples/benchmark/step1_make_cases.py convert \
    config=examples/benchmark/configs/step1_convert_cases.yaml \
    home="$home" \
    -- "$@"
