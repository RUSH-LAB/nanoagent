#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer currently supports macOS only." >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Homebrew is installed here on Apple Silicon and under /usr/local on Intel.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

echo "Installing Node.js 22, Python 3.12, and uv..."
brew install node@22 python@3.12 uv

# Make the versioned Node installation available in this process.
export PATH="$(brew --prefix node@22)/bin:$PATH"

echo "Installing Mochi Lab JavaScript dependencies..."
cd "$(dirname "$0")"
npm ci

NANOAGENT_PROJECT_DIR="${NANOAGENT_PROJECT_DIR:-$(cd .. && pwd)/nanoagent}"
NANOAGENT_REPOSITORY="${NANOAGENT_REPOSITORY:-https://github.com/zeyuyang8/nanoagent.git}"
NANOAGENT_REF="${NANOAGENT_REF:-master}"

if [[ ! -f "$NANOAGENT_PROJECT_DIR/pyproject.toml" ]]; then
  echo "Cloning NanoAgent into $NANOAGENT_PROJECT_DIR..."
  git clone --branch "$NANOAGENT_REF" --single-branch "$NANOAGENT_REPOSITORY" "$NANOAGENT_PROJECT_DIR"
else
  echo "Using existing NanoAgent checkout at $NANOAGENT_PROJECT_DIR."
fi

if [[ ! -f .env.openrouter.local ]]; then
  cp .env.openrouter.local.example .env.openrouter.local
  echo "Created .env.openrouter.local from its sanitized template."
fi

echo
echo "Installation complete."
echo "Node:   $(node --version)"
echo "npm:    $(npm --version)"
echo "Python: $(python3.12 --version)"
echo "uv:     $(uv --version)"
echo
echo "Next steps:"
echo "  Add OPENROUTER_API_KEY to .env.openrouter.local"
echo "  npm run db:postgres:setup"
echo "  npm start"
