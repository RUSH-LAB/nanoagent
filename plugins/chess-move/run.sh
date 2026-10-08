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

# msa's checkout (an editable dependency) knows where its board and its Stockfish build are.
msa_root=$(uv run --frozen --quiet python -c "from msa import REPO_ROOT; print(REPO_ROOT)")
stockfish=$(uv run --frozen --quiet python -c "from plugin.engine import BINARY; print(BINARY)")
[[ -x "$stockfish" ]] || { echo "no Stockfish at $stockfish: build it with $msa_root/sandbox.sh" >&2; exit 1; }
[[ -d "$msa_root/node_modules/chessgroundx" ]] || {
    echo "the board is not installed: run \`npm ci\` in $msa_root" >&2; exit 1; }
browser=$(uv run --frozen --quiet python -c "from msa.cdp import Headless; print(Headless().binary or '')")
[[ -x "$browser" ]] || { echo "no Chrome installed (msa.cdp.Headless.CHROMES)" >&2; exit 1; }
