#!/usr/bin/env bash
# The golden image's entrypoint (deploy/gvisor/Dockerfile). Brings up what the worker's Linux host needs, as root, then runs
# the worker (no arguments) or the given command as the unprivileged `rush` user.
#
# Environment the worker reads (config deploy/gvisor/worker.openrouter.yaml):
#   RUSH_WORKER_TOKEN  the worker's bearer credential for RUSH
#   OPENROUTER_API_KEY      the key inference is paid with
# RUSH's address is `rush.base_url` in that YAML; point the worker elsewhere with an override after `--`:
#   python -m nanoagent.uploaded.worker config=... home=... -- rush.base_url=http://host.docker.internal:3000
set -euo pipefail
gvisor=/opt/nanoagent/deploy/gvisor
: "${RUSH_WORKER_HOME:?}"

# cgroup v2 nesting (as moby's hack/dind does): move our processes out of the root cgroup so controllers can be delegated.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi

# Registers runsc-rush in /etc/docker/daemon.json and creates the collector socket directory (no systemd here, so no restart).
RUSH_WORKER_USER=rush RUSH_RUNSC_PATH=/usr/bin/runsc python "$gvisor/setup.py"

dockerd > /var/log/dockerd.log 2>&1 &
for _ in $(seq 120); do docker info > /dev/null 2>&1 && break; sleep 0.5; done
docker info > /dev/null 2>&1 || { echo "dockerd did not come up; its log:" >&2; cat /var/log/dockerd.log >&2; exit 1; }

bash "$gvisor/egress.sh"

mkdir -p "$RUSH_WORKER_HOME" && chown rush:rush "$RUSH_WORKER_HOME"
# A volume an older image seeded can hold root's files (its uv cache); the worker runs as rush, so it takes them over.
find "$RUSH_WORKER_HOME" -xdev ! -user rush -exec chown -h rush:rush {} +
if [ "$#" -eq 0 ]; then
  cd "$RUSH_WORKER_HOME"
  set -- python -m nanoagent.uploaded.worker config="$gvisor/worker.openrouter.yaml" home="$RUSH_WORKER_HOME/run"
else
  cd /opt/nanoagent  # another command (pytest) runs from the project, where pyproject.toml and test/ are
fi
# Keep the image's environment (PATH, UV_*) and hand over the worker's credentials and the home directory.
exec runuser -u rush -- env HOME=/home/rush "$@"
