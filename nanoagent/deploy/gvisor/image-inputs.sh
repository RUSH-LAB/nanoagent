#!/usr/bin/env bash
# Prints one hash of the files the worker image is built from: the paths deploy/gvisor/Dockerfile copies, as git records
# them at HEAD. The image workflow labels each platform image with it (benchmark-worker-image.yml) and the pin check
# compares RUSH Lab's pinned image against it (benchmark-worker-pin.yml). Run from the repository root.
set -euo pipefail
git ls-tree HEAD \
  nanoagent/pyproject.toml nanoagent/uv.lock nanoagent/README.md nanoagent/LICENSE \
  nanoagent/src nanoagent/deploy/gvisor nanoagent/test \
  | git hash-object --stdin
