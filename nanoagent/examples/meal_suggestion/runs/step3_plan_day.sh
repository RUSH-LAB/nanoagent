#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/nanoagent plugin agent \
    config=examples/meal_suggestion/configs/step3_plan_day.yaml \
    home=examples/meal_suggestion/outputs/step3_plan_day \
    "$@"
