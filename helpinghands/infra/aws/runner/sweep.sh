#!/usr/bin/env bash
# Starts the sweep of RUSH Lab cloud's run folders (sweep.py) beside the runner, in a container of
# its own, from the runner's image (docs/infra/aws-deployment.md). The rollout (infra/aws/rollout.sh)
# and the runner check (scripts/aws/verify-runner.mjs) both start it here.
#
#   sweep.sh <image> <data folder>      the data folder run.sh gives the runner
#
# It runs as the runner does, uid 10001, with no capability, no network and a read-only root, and
# writes only the data folder. SWEEP_NAME changes its name; LOG_GROUP (with AWS_REGION) sends its
# log to CloudWatch, else Docker keeps it, rotated.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: sweep.sh <image> <data folder>" >&2; exit 2; }
image=$1 data=$2
here=$(cd "$(dirname "$0")" && pwd)
logging=(--log-driver json-file --log-opt max-size=1m --log-opt max-file=3)
if [ -n "${LOG_GROUP:-}" ]; then
  logging=(--log-driver awslogs --log-opt "awslogs-group=$LOG_GROUP" --log-opt "awslogs-region=${AWS_REGION:?LOG_GROUP needs AWS_REGION}" --log-opt awslogs-stream=sweep)
fi
exec docker run --detach --name "${SWEEP_NAME:-rush-lab-sweep}" --restart unless-stopped \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --network none --memory 128m --pids-limit 32 \
  --volume "$data:/data" --volume "$here/sweep.py:/sweep.py:ro" \
  "${logging[@]}" \
  "$image" \
  python /sweep.py
