#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/nanoagent"
.venv/bin/python \
    examples/meal_suggestion/step1_build_foodcom_recipes.py \
    config=examples/meal_suggestion/configs/step1_build_foodcom_recipes.yaml \
    home=examples/meal_suggestion/outputs/step1_build_foodcom_recipes \
    "$@"
