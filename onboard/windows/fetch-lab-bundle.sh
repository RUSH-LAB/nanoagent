#!/bin/sh
# Copies rush-lab.org's Linux RUSH Lab bundle into the local site, which has none: db:pull leaves
# the bundles out, and only a release uploads one (routes/lab.js). Run it in WSL (Ubuntu) from
# anywhere, with a download token from rush-lab.org (the token in the install command it shows
# signed in, Settings, Connection):
#
#   PRODUCTION_TOKEN='<token>' sh onboard/windows/fetch-lab-bundle.sh
#
# It needs LAB_UPLOAD_TOKEN in helpinghands/.env, and the local site running.
set -eu

SITE=https://rush-lab.org
LOCAL=http://localhost:3001
TARGET=x86_64-unknown-linux-gnu

fail() {
  echo "The RUSH Lab bundle was not copied: $*" >&2
  exit 1
}

[ -n "${PRODUCTION_TOKEN:-}" ] || fail "set PRODUCTION_TOKEN to the token of the install command on $SITE."
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/helpinghands/.env"
UPLOAD_TOKEN=$(sed -n "s/^LAB_UPLOAD_TOKEN='\(.*\)'\$/\1/p" "$ENV_FILE")
[ -n "$UPLOAD_TOKEN" ] || fail "LAB_UPLOAD_TOKEN is empty in $ENV_FILE."

WORK=$(mktemp -d) || fail "could not make a temporary folder."
trap 'rm -rf "$WORK"' EXIT

echo "Downloading the $TARGET bundle from $SITE..."
curl -fSL --progress-bar -D "$WORK/headers" -o "$WORK/bundle.tar.gz" "$SITE/api/lab/bundles/$TARGET?token=$PRODUCTION_TOKEN" \
  || fail "the download from $SITE failed (a token lasts an hour)."
STAMP=$(tr -d '\r' < "$WORK/headers" | grep -i '^x-lab-stamp:' | tail -n 1 | cut -d: -f2- | tr -d ' ')
[ -n "$STAMP" ] || fail "$SITE sent no X-Lab-Stamp header."

echo "Uploading $STAMP to $LOCAL..."
curl -fS -X PUT -H "Authorization: Bearer $UPLOAD_TOKEN" -H "X-Lab-Stamp: $STAMP" -H 'Content-Type: application/gzip' \
  --data-binary "@$WORK/bundle.tar.gz" "$LOCAL/api/lab/bundles/$TARGET" \
  || fail "the local site refused the upload; is npm start running with LAB_UPLOAD_TOKEN set?"
echo
echo "Done: the local site now has RUSH Lab $STAMP for $TARGET."
