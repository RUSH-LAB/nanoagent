#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
.venv/bin/nanoagent plugin agent \
    config=examples/meal_suggestion/configs/step2_suggest_meal.yaml \
    home=examples/meal_suggestion/outputs/step2_suggest_meal \
    "$@"
