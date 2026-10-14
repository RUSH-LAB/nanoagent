#!/bin/sh
# Mochi Lab without its window, installed with one line: Mochi serves this script with its site
# and the member's download token filled in (routes/lab.js). It downloads this Mac's bundle
# (desktop/scripts/bundle-lab.mjs), checks it against the sha256 Mochi sends, unpacks it into
# ~/Library/Application Support/lab.mochi.lab/app/<stamp>/, and has launchd run lab.mjs from it at
# every login, starting it again when it fails (lab.mjs). Any failure stops it, with the reason.
set -eu

SITE='__MOCHI_SITE__'
TOKEN='__MOCHI_TOKEN__'
LABEL=lab.mochi.lab
DATA="$HOME/Library/Application Support/$LABEL"
APPS="$DATA/app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="gui/$(id -u)/$LABEL"

fail() {
  echo "Mochi Lab was not installed: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "it runs on macOS only, where plugins run in its sandbox; this is $(uname -s)."
case "$(uname -m)" in
  arm64) TARGET=aarch64-apple-darwin ;;
  x86_64) TARGET=x86_64-apple-darwin ;;
  *) fail "there is no bundle for this Mac's $(uname -m) processor." ;;
esac

WORK=$(mktemp -d) || fail "could not make a temporary folder."
trap 'rm -rf "$WORK"' EXIT

echo "Downloading Mochi Lab for $TARGET from $SITE..."
curl -fSL --progress-bar -D "$WORK/headers" -o "$WORK/bundle.tar.gz" "$SITE/api/lab/bundles/$TARGET?token=$TOKEN" \
  || fail "the download from $SITE failed."
# The last response's headers: a redirect's come first.
header() {
  tr -d '\r' < "$WORK/headers" | grep -i "^$1:" | tail -n 1 | cut -d: -f2- | tr -d ' '
}
STAMP=$(header X-Lab-Stamp)
SHA256=$(header X-Lab-Sha256)
printf '%s' "$STAMP" | grep -Eq '^[A-Za-z0-9._-]+$' || fail "$SITE sent no valid X-Lab-Stamp header."
printf '%s' "$SHA256" | grep -Eq '^[0-9a-f]{64}$' || fail "$SITE sent no valid X-Lab-Sha256 header."
ACTUAL=$(shasum -a 256 "$WORK/bundle.tar.gz" | cut -d' ' -f1)
[ "$ACTUAL" = "$SHA256" ] || fail "the download's sha256 is $ACTUAL, not the $SHA256 $SITE sent."
echo "Verified Mochi Lab $STAMP (sha256 $SHA256)."

mkdir -p "$APPS" "$DATA/logs" "$HOME/Library/LaunchAgents" || fail "could not make $DATA."
PARTIAL="$APPS/.$STAMP.partial"
rm -rf "$PARTIAL"
mkdir "$PARTIAL"
tar -xzf "$WORK/bundle.tar.gz" -C "$PARTIAL" || fail "could not unpack the bundle."
[ "$(cat "$PARTIAL/mochi-lab/stamp" 2>/dev/null)" = "$STAMP" ] || fail "the bundle is not Mochi Lab $STAMP."

# Stop the Mochi Lab running now, if one is, before its files go.
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "Stopping the Mochi Lab running now..."
  launchctl bootout "$SERVICE" || fail "launchctl could not stop $SERVICE."
  waited=0
  while launchctl print "$SERVICE" >/dev/null 2>&1; do
    [ "$waited" -lt 30 ] || fail "$SERVICE did not stop within 30s."
    sleep 1
    waited=$((waited + 1))
  done
fi

rm -rf "${APPS:?}/$STAMP"
mv "$PARTIAL" "$APPS/$STAMP"
ln -sfn "$STAMP" "$APPS/current"
for old in "$APPS"/* "$APPS"/.*.partial; do
  [ -e "$old" ] || [ -L "$old" ] || continue
  case "$(basename "$old")" in
    "$STAMP" | current) ;;
    *) rm -rf "$old" || fail "could not remove $old." ;;
  esac
done
echo "Installed into $APPS/$STAMP."

# Paths in the plist are XML text.
xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
BUNDLE="$APPS/current/mochi-lab"
cat > "$PLIST" <<EOF || fail "could not write $PLIST."
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$BUNDLE/bin/node")</string>
    <string>$(xml "$BUNDLE/runner/lab.mjs")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- Started again when it fails; a clean exit (another computer took the member's runs) is final. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <!-- lab.mjs takes up to 10s to stop each of its two services. -->
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$DATA/logs/lab.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$DATA/logs/lab.log")</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || fail "$PLIST is not a valid plist."
launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "launchctl could not start $PLIST."

cat <<EOF
Mochi Lab is running, and starts at every login.
A browser page opens to sign in to Mochi and approve this computer, the first time.
Logs: $DATA/logs/ (lab.log, then uv-sync.log, nanoagent.log and relay.log)
To uninstall it:
  launchctl bootout $SERVICE
  rm -rf "$PLIST" "$DATA"
EOF
