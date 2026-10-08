#!/usr/bin/env bash
# Exits 0 when this environment can run the plugin. NanoAgent runs it before every launch,
# with the environment the plugin will get.

set -euo pipefail

cd "$(dirname "$0")"

command -v uv >/dev/null || { echo "uv is not installed" >&2; exit 1; }

while IFS= read -r line || [[ -n "$line" ]]; do
    name="${line%%=*}"
    [[ -z "$name" || "$name" == \#* ]] && continue
    [[ -n "${!name:-}" ]] || { echo "$name is not set (declared in .env)" >&2; exit 1; }
done < .env

uv lock --check --offline --quiet || { echo "uv.lock is out of date with pyproject.toml" >&2; exit 1; }
