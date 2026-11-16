#!/usr/bin/env bash
# Runs the uploaded-harness tests inside the Linux execution VM against the checkout's src/.
#
#   limactl shell gvisor-dev -- bash deploy/gvisor/vm-test.sh [pytest args]
#
# The checkout is mounted read-only in the VM, so the venv, caches and scratch live under
# $RUSH_WORKER_HOME (default ~/rush-worker). The venv is built from the project's uv.lock
# (`uv sync --frozen`, no editable install) and imports the checkout through PYTHONPATH.
# Default pytest selection is the sandbox and collector tests including the gvisor-marked ones.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
project="$(cd "$here/../.." && pwd)"
home="${RUSH_WORKER_HOME:-/home/$(id -un).guest/rush-worker}"
mkdir -p "$home/scratch"
# One collector socket serves the VM, so worker and test processes take turns: the lock is held until the process exits.
exec 9>"$home/collector.lock"
flock 9
export UV_PROJECT_ENVIRONMENT="$home/venv" UV_CACHE_DIR="$home/uv-cache"
uv sync --project "$project" --frozen --no-install-project --extra web --inexact --quiet
# The lock can trail pyproject.toml while dependencies are being added; install what it lacks.
uv pip install --python "$home/venv/bin/python" --quiet "protobuf>=7.35.1,<8" rfc3986-validator pytest pytest-asyncio
# Plugin helpers run as `python -I -m nanoagent`, which ignores PYTHONPATH: a .pth file makes the checkout importable there too.
"$home/venv/bin/python" -c "import site, pathlib, sys; pathlib.Path(site.getsitepackages()[0], 'rush-checkout.pth').write_text(sys.argv[1] + chr(10))" "$project/src"
export PYTHONPATH="$project/src" PYTHONDONTWRITEBYTECODE=1 RUSH_WORKER_HOME="$home"
export RUSH_SECCHECK_SOCKET="${RUSH_SECCHECK_SOCKET:-/run/rush-gvisor/seccheck.sock}"
# The packet filter behind `limits.internet_access` (sudo; harmless to repeat). Tests that need it say so when it is missing.
sudo -n bash "$here/egress.sh" >/dev/null 2>&1 || echo "note: deploy/gvisor/egress.sh was not installed (no passwordless sudo)" >&2
cd "$project"
if [ "$#" -eq 0 ]; then
  set -- test/uploaded/test_sandbox*.py test/uploaded/test_collector*.py test/uploaded/test_toolchains*.py
fi
exec "$home/venv/bin/python" -m pytest -p no:cacheprovider -o addopts="" -m "gvisor or not gvisor" "$@"
