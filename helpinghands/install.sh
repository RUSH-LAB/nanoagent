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

echo "Installing RUSH Lab JavaScript dependencies..."
cd "$(dirname "$0")"
npm ci

node scripts/dev/consolidate-env.mjs --initialize

echo
echo "Installation complete."
echo "Node:   $(node --version)"
echo "npm:    $(npm --version)"
echo "Python: $(python3.12 --version)"
echo "uv:     $(uv --version)"
echo
echo "Next steps:"
echo "  Fill in the GitHub values in .env (scripts/README.md)"
echo "  brew install postgresql@18"
echo "  npm run db:setup"
echo "  npm run db:pull"
echo "  npm start"
