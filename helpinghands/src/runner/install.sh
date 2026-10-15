#!/bin/sh
# Mochi Lab without its window, installed with one line: Mochi serves this script with its site
# and the member's download token filled in (routes/lab.js). It downloads this computer's bundle
# (desktop/scripts/bundle-lab.mjs), checks it against the sha256 Mochi sends, unpacks it into the
# data folder's app/<stamp>/, and has the service manager run lab.mjs from it at every login,
# under the label the bundle gives this site (lab.mjs's installFor: another site's runs beside it),
# starting it again when it fails (lab.mjs): launchd on macOS, systemd on Linux and in Windows's
# WSL2. Any failure stops it, with the reason.
set -eu

SITE='__MOCHI_SITE__'
TOKEN='__MOCHI_TOKEN__'

fail() {
  echo "RUSH Lab was not installed on this computer: $*" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Darwin-* | Linux-*) fail "there is no bundle for this computer's $(uname -m) processor." ;;
  *) fail "it runs on macOS and Linux (on Windows, in WSL2), where plugins run in a sandbox; this is $(uname -s)." ;;
esac
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  # Plugins run in bubblewrap, in a user namespace of their own (nanoagent.plugin.sandbox).
  command -v bwrap >/dev/null 2>&1 \
    || fail "plugins run in bubblewrap, which is not installed. Install it (on Ubuntu: sudo apt install bubblewrap) and run this again."
  bwrap --unshare-all --ro-bind / / true 2>/dev/null \
    || fail "bubblewrap cannot make a sandbox here. On Ubuntu 23.10 and later, AppArmor stops it; see https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces"
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail "it runs as a systemd user service, and systemd is not running for you. In WSL, add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, and open Ubuntu again."
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

WORK=$(mktemp -d) || fail "could not make a temporary folder."
trap 'rm -rf "$WORK"' EXIT

echo "Downloading RUSH Lab for $TARGET from $SITE..."
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
ACTUAL=$(sha256 "$WORK/bundle.tar.gz")
[ "$ACTUAL" = "$SHA256" ] || fail "the download's sha256 is $ACTUAL, not the $SHA256 $SITE sent."
echo "Verified RUSH Lab $STAMP (sha256 $SHA256)."

UNPACKED="$WORK/unpacked"
mkdir "$UNPACKED"
tar -xzf "$WORK/bundle.tar.gz" -C "$UNPACKED" || fail "could not unpack the bundle."
[ "$(cat "$UNPACKED/mochi-lab/stamp" 2>/dev/null)" = "$STAMP" ] || fail "the bundle is not RUSH Lab $STAMP."
LABEL=$("$UNPACKED/mochi-lab/bin/node" "$UNPACKED/mochi-lab/runner/lab.mjs" label "$SITE") \
  || fail "the bundle could not say what to install as for $SITE."
printf '%s' "$LABEL" | grep -Eq '^[A-Za-z0-9.-]+$' || fail "the bundle named no valid label for $SITE."
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  DATA="$HOME/.local/share/$LABEL"
  UNIT="$HOME/.config/systemd/user/$LABEL.service"
else
  DATA="$HOME/Library/Application Support/$LABEL"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  SERVICE="gui/$(id -u)/$LABEL"
fi
APPS="$DATA/app"
mkdir -p "$APPS" "$DATA/logs" || fail "could not make $DATA."

# Stop the one running now, if one is, before its files go.
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  systemctl --user stop "$LABEL.service" 2>/dev/null || true
elif launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "Stopping the RUSH Lab running on this computer now..."
  launchctl bootout "$SERVICE" || fail "launchctl could not stop $SERVICE."
  waited=0
  while launchctl print "$SERVICE" >/dev/null 2>&1; do
    [ "$waited" -lt 30 ] || fail "$SERVICE did not stop within 30s."
    sleep 1
    waited=$((waited + 1))
  done
fi

rm -rf "${APPS:?}/$STAMP"
mv "$UNPACKED" "$APPS/$STAMP" || fail "could not move the bundle into $APPS."
ln -sfn "$STAMP" "$APPS/current"
# The site this installation serves (lab.mjs reads it).
printf '%s\n' "$SITE" > "$DATA/site" || fail "could not write $DATA/site."
for old in "$APPS"/* "$APPS"/.*.partial; do
  [ -e "$old" ] || [ -L "$old" ] || continue
  case "$(basename "$old")" in
    "$STAMP" | current) ;;
    *) rm -rf "$old" || fail "could not remove $old." ;;
  esac
done
echo "Installed into $APPS/$STAMP."

# This computer's session, for the relay (relay.mjs reads it): the link was the member's, signed in,
# so it connects with no sign-in page. A session that later lapses asks for one (lab.mjs).
SESSION=$(curl -fsS -X POST "$SITE/api/lab/session?token=$TOKEN") || fail "$SITE gave no session for this computer."
printf '%s' "$SESSION" | grep -Eq '^[A-Za-z0-9._-]+$' || fail "$SITE gave no valid session for this computer."
(umask 077 && printf '{"site":"%s","token":"%s"}\n' "$SITE" "$SESSION" > "$DATA/runner-credentials.json") \
  || fail "could not keep this computer's session in $DATA."


BUNDLE="$APPS/current/mochi-lab"
# Where lab.mjs logs; it says there which page signs this computer in.
LOG="$DATA/logs/lab.log"
: > "$LOG"
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  mkdir -p "$(dirname "$UNIT")" || fail "could not make $(dirname "$UNIT")."
  # Started again when it fails; a clean exit (another computer took the member's runs) is final.
  cat > "$UNIT" <<EOF || fail "could not write $UNIT."
[Unit]
Description=RUSH Lab: this computer's NanoAgent, lent to $SITE

[Service]
ExecStart="$BUNDLE/bin/node" "$BUNDLE/runner/lab.mjs"
Restart=on-failure
RestartSec=30
# lab.mjs takes up to 10s to stop each of its two services.
TimeoutStopSec=30
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || fail "systemd could not read $UNIT."
  systemctl --user enable --now "$LABEL.service" || fail "systemd could not start $LABEL.service."
  UNINSTALL="systemctl --user disable --now $LABEL.service
  rm -rf \"$UNIT\" \"$DATA\""
else
  # Paths in the plist are XML text.
  xml() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
  }
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
  UNINSTALL="launchctl bootout $SERVICE
  rm -rf \"$PLIST\" \"$DATA\""
fi

# Until lab.mjs is connected, or asks for a sign-in page after all, which opens in the browser where
# it can and is printed here too. The first start downloads Python.
waited=0
PAGE=
CONNECTED=
while [ "$waited" -lt 180 ]; do
  grep -q 'Connected to' "$LOG" 2>/dev/null && CONNECTED=1 && break
  PAGE=$(grep -o 'approve this computer.*' "$LOG" 2>/dev/null | head -n 1 | sed 's/.*: //') || true
  [ -n "$PAGE" ] && break
  sleep 2
  waited=$((waited + 2))
done

echo "RUSH Lab runs on this computer now, and starts at every login."
if [ -n "$CONNECTED" ]; then
  echo "It is connected to $SITE: go back to your browser."
elif [ -n "$PAGE" ]; then
  echo "To finish, approve this computer: $PAGE"
else
  echo "It is still starting; $LOG says when it is connected."
fi
cat <<EOF
Logs: $DATA/logs/ (lab.log, then uv-sync.log, nanoagent.log and relay.log)
To uninstall it:
  $UNINSTALL
EOF
