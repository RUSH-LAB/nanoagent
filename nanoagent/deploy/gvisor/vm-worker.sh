#!/usr/bin/env bash
# Runs a Python entry point of the uploaded-harness worker inside the Linux execution VM, against the checkout's src/.
#
#   limactl shell gvisor-dev -- bash deploy/gvisor/vm-worker.sh -m nanoagent.uploaded.worker config=<yaml> home=<folder>
#
# It reuses the venv deploy/gvisor/vm-test.sh builds under $RUSH_WORKER_HOME. The checkout is read-only in the VM, so the
# process starts in $RUSH_WORKER_HOME. With RUSH_WORKER_PIDFILE set, the process's pid is written there first so a
# caller can signal it (SIGINT stops the worker the way Ctrl-C does).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
project="$(cd "$here/../.." && pwd)"
home="${RUSH_WORKER_HOME:-/home/$(id -un).guest/rush-worker}"
[ -x "$home/venv/bin/python" ] || { echo "no venv at $home/venv: run deploy/gvisor/vm-test.sh once first" >&2; exit 2; }
export PYTHONPATH="$project/src" PYTHONDONTWRITEBYTECODE=1 RUSH_WORKER_HOME="$home"
cd "$home"
if [ -n "${RUSH_WORKER_PIDFILE:-}" ]; then echo $$ > "$RUSH_WORKER_PIDFILE"; fi
# One collector socket serves the VM, so worker and test processes take turns: the lock is held until the process exits.
exec 9>"$home/collector.lock"
flock 9
exec "$home/venv/bin/python" "$@"
