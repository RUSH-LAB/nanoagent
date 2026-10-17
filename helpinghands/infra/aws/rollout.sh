#!/usr/bin/env bash
# One deploy of this VM's half of RUSH Lab cloud (docs/infra/aws-deployment.md). SSM Run Command
# runs it as root from a checkout of the commit it deploys (scripts/aws/deploy.mjs):
#
#   infra/aws/rollout.sh <web|runner> <image>     the image: <ECR repository>:<commit>
#
# It reads /etc/rush-lab/stack.env, which the VM's first boot wrote (infra/aws/stack.yaml): STACK,
# AWS_REGION and DOMAIN. The containers' settings come from SSM Parameter Store, every parameter
# under /rush-lab/<stack>/shared/ and /rush-lab/<stack>/<role>/, into an env file on tmpfs that
# only root reads. It replaces the role's containers (web/run.sh; runner/run.sh and the sweep of
# its run folders, runner/sweep.sh), waits until they answer, and removes images more than a week old.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: rollout.sh <web|runner> <image>" >&2; exit 2; }
role=$1 image=$2
case "$role" in web|runner) ;; *) echo "the role is web or runner, not $role" >&2; exit 2 ;; esac
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
. /etc/rush-lab/stack.env
: "${STACK:?stack.env names no STACK}" "${AWS_REGION:?stack.env names no AWS_REGION}" "${DOMAIN:?stack.env names no DOMAIN}"

umask 077
mkdir -p /run/rush-lab
env_file=/run/rush-lab/$role.env
python3 - "$STACK" "$role" "$AWS_REGION" > "$env_file" <<'PY'
import json, subprocess, sys

stack, role, region = sys.argv[1:4]
lines = []
for path in (f"/rush-lab/{stack}/shared/", f"/rush-lab/{stack}/{role}/"):
    listed = subprocess.run(
        ["aws", "ssm", "get-parameters-by-path", "--region", region, "--path", path,
         "--recursive", "--with-decryption", "--output", "json"],
        check=True, capture_output=True, text=True,
    ).stdout
    for parameter in json.loads(listed)["Parameters"]:
        name, value = parameter["Name"].rsplit("/", 1)[1], parameter["Value"]
        if "\n" in value or "\r" in value:
            sys.exit(f"{parameter['Name']} holds a line break, which an env file cannot")
        lines.append(f"{name}={value}")
print("\n".join(lines))
PY

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${image%%/*}" >/dev/null
docker pull --quiet "$image" >/dev/null
export LOG_GROUP="/rush-lab/$STACK/$role" AWS_REGION

# The address of this VM in the VPC, from its instance metadata (IMDSv2).
private_ip() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/local-ipv4
}

# Wait until `test` passes, for at most `seconds`.
wait_for() {
  local seconds=$1; shift
  for _ in $(seq 1 "$seconds"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "$role" = runner ]; then
  docker rm --force rush-lab-runner rush-lab-sweep >/dev/null 2>&1 || true
  install -d -o 10001 -g 10001 -m 0700 /var/lib/rush-lab/runner
  address=$(private_ip)
  "$here/runner/run.sh" "$image" "$env_file" /var/lib/rush-lab/runner "$address:8787" >/dev/null
  if ! wait_for 180 curl -fsS "http://$address:8787/health"; then
    docker logs --tail 40 rush-lab-runner >&2 || true
    echo "the runner did not answer /health" >&2
    exit 1
  fi
  "$here/runner/sweep.sh" "$image" /var/lib/rush-lab/runner >/dev/null
else
  docker rm --force rush-lab-caddy rush-lab-web >/dev/null 2>&1 || true
  "$here/web/run.sh" "$image" "$env_file" "$DOMAIN"
  # Mochi's image checks itself (helpinghands/Dockerfile HEALTHCHECK), migrations first.
  web_healthy() { [ "$(docker inspect --format '{{.State.Health.Status}}' rush-lab-web)" = healthy ]; }
  if ! wait_for 600 web_healthy; then
    docker logs --tail 40 rush-lab-web >&2 || true
    echo "Mochi did not become healthy" >&2
    exit 1
  fi
fi
docker image prune --all --force --filter "until=168h" >/dev/null
echo "$role is running $image"
