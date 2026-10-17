#!/usr/bin/env bash
# Starts RUSH Lab cloud's website: Mochi (helpinghands/Dockerfile's image) behind Caddy, which
# holds the domain's certificate (docs/infra/aws-deployment.md). The rollout
# (infra/aws/rollout.sh) and the local stack (infra/aws/local/) both start it here.
#
#   run.sh <image> <env file> <domain>
#
# The env file holds Mochi's secrets and NANOAGENT_URL, the runner (docs/infra/aws-deployment.md
# lists them). This site offers RUSH Lab cloud (CLOUD_RUNS=on), on that runner.
# WEB_HTTP_PORT and WEB_HTTPS_PORT publish Caddy elsewhere than 80 and 443, as on a laptop;
# SITE_URL is then the address with its port. LOG_GROUP (with AWS_REGION) sends both logs to
# CloudWatch, else Docker keeps them, rotated.
set -euo pipefail
[ "$#" -eq 3 ] || { echo "usage: run.sh <image> <env file> <domain>" >&2; exit 2; }
image=$1 env_file=$2 domain=$3
here=$(cd "$(dirname "$0")" && pwd)
http_port=${WEB_HTTP_PORT:-80}
https_port=${WEB_HTTPS_PORT:-443}
if [ "$https_port" = 443 ]; then site="https://$domain"; else site="https://$domain:$https_port"; fi
site=${SITE_URL:-$site}
caddy=caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb

logging() {
  if [ -n "${LOG_GROUP:-}" ]; then
    echo --log-driver awslogs --log-opt "awslogs-group=$LOG_GROUP" --log-opt "awslogs-region=${AWS_REGION:?LOG_GROUP needs AWS_REGION}" --log-opt "awslogs-stream=$1"
  else
    echo --log-driver json-file --log-opt max-size=10m --log-opt max-file=5
  fi
}
read -r -a web_logging <<< "$(logging web)"
read -r -a caddy_logging <<< "$(logging caddy)"

docker network inspect rush-lab >/dev/null 2>&1 || docker network create rush-lab >/dev/null
docker run --detach --name rush-lab-web --restart unless-stopped --network rush-lab \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory "${WEB_MEMORY:-1536m}" --pids-limit 512 \
  --env-file "$env_file" \
  --env NODE_ENV=production --env "SITE_URL=$site" --env "CORS_ORIGIN=$site" --env CLOUD_RUNS=on \
  "${web_logging[@]}" \
  "$image" >/dev/null
docker run --detach --name rush-lab-caddy --restart unless-stopped --network rush-lab \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
  --publish "$http_port:80" --publish "$https_port:443" --publish "$https_port:443/udp" \
  --volume rush-lab-caddy-data:/data --volume rush-lab-caddy-config:/config \
  --volume "$here/Caddyfile:/etc/caddy/Caddyfile:ro" \
  --env "DOMAIN=$domain" \
  "${caddy_logging[@]}" \
  "$caddy" >/dev/null
echo "rush-lab-web and rush-lab-caddy started for $site"
