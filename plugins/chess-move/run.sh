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

[[ -d "$MSA_ROOT/src/msa" ]] || { echo "MSA_ROOT=$MSA_ROOT is not a mind-sports-arena checkout" >&2; exit 1; }
[[ -x "$LOCALDB/stockfish/bin/stockfish" ]] || {
    echo "no Stockfish at $LOCALDB/stockfish/bin/stockfish: build it with $MSA_ROOT/sandbox.sh" >&2; exit 1; }
[[ -d "$MSA_ROOT/node_modules/chessgroundx" ]] || {
    echo "the board is not installed: run \`npm ci\` in $MSA_ROOT" >&2; exit 1; }
[[ -x "$CHROME_BIN" ]] || { echo "no browser at CHROME_BIN=$CHROME_BIN" >&2; exit 1; }

uv lock --check --offline --quiet || { echo "uv.lock is out of date with pyproject.toml" >&2; exit 1; }
