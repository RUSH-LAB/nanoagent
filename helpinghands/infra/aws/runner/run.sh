#!/usr/bin/env bash
# Starts RUSH Lab cloud's runner: NanoAgent in its container, every plugin it runs confined by
# bubblewrap (docs/infra/aws-deployment.md). The rollout (infra/aws/rollout.sh) and the runner
# check (scripts/aws/verify-runner.mjs) both start it here, so both run these exact flags.
#
#   run.sh <image> <env file> <data folder> <address:port to publish on> [NanoAgent overrides...]
#
# The env file holds NANOAGENT_API_TOKEN and OPENROUTER_API_KEY. The data folder, owned by uid
# 10001, keeps plugin installs, their uv cache and each run's folder across restarts. What the
# flags do, each needed (verify-runner.mjs shows NanoAgent refusing to start without the seccomp
# rule or the unmasked /proc):
#   --user 10001, --cap-drop ALL, no-new-privileges   no root, no capability, nothing gained by exec
#   seccomp.json        Docker's default profile and the namespace and mount calls bubblewrap makes
#                       (scripts/aws/seccomp.mjs); Docker's own allows them only with CAP_SYS_ADMIN
#   systempaths=unconfined   bubblewrap mounts a /proc of its own, which Docker's masked paths forbid
#   apparmor=unconfined      Amazon Linux has no AppArmor; on Ubuntu, Docker's profile forbids those mounts
#   bwrap                    the bubblewrap NanoAgent finds first: no user namespace of a plugin's own,
#                       and a plugin's processes the first stopped when memory runs out (./bwrap)
#   --read-only, --tmpfs /tmp   nothing written but /tmp and the data folder
#   --memory, --cpus, --pids-limit   NanoAgent limits no plugin's memory, CPU or processes; the
#                       container bounds them all, and ends a plugin's processes with its run
#   --add-host host.docker.internal   names the VM itself, for a model served there (the runner
#                       check's scripted one); NanoAgent reaches the VM's bridge address either way,
#                       and a plugin has no network but its egress proxy
# RUNNER_NAME, RUNNER_MEMORY, RUNNER_CPUS and RUNNER_PIDS change those; LOG_GROUP (with AWS_REGION)
# sends its log to CloudWatch, else Docker keeps it, rotated.
set -euo pipefail
[ "$#" -ge 4 ] || { echo "usage: run.sh <image> <env file> <data folder> <address:port> [overrides...]" >&2; exit 2; }
image=$1 env_file=$2 data=$3 publish=$4
shift 4
here=$(cd "$(dirname "$0")" && pwd)
logging=(--log-driver json-file --log-opt max-size=10m --log-opt max-file=5)
if [ -n "${LOG_GROUP:-}" ]; then
  logging=(--log-driver awslogs --log-opt "awslogs-group=$LOG_GROUP" --log-opt "awslogs-region=${AWS_REGION:?LOG_GROUP needs AWS_REGION}" --log-opt awslogs-stream=runner)
fi
exec docker run --detach --name "${RUNNER_NAME:-rush-lab-runner}" --restart unless-stopped \
  --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt "seccomp=$here/seccomp.json" \
  --security-opt systempaths=unconfined \
  --security-opt apparmor=unconfined \
  --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g \
  --volume "$data:/data" --volume "$here/bwrap:/usr/local/bin/bwrap:ro" \
  --memory "${RUNNER_MEMORY:-3g}" --memory-swap "${RUNNER_MEMORY:-3g}" \
  --cpus "${RUNNER_CPUS:-1.8}" --pids-limit "${RUNNER_PIDS:-1024}" \
  --add-host host.docker.internal:host-gateway \
  --env-file "$env_file" --env HOME=/tmp \
  --publish "$publish:8787" \
  "${logging[@]}" \
  "$image" \
  python -m nanoagent web web_cfg=deploy/railway/nanoagent.yaml \
    sandbox=bwrap include_reasoning=true workspaces=/data/nanoagent-workspaces "$@"
