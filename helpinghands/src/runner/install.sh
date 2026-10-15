#!/bin/sh
# Mochi Lab without its window, installed with one line: Mochi serves this script with its site
# and the member's download token filled in (routes/lab.js). It downloads this computer's bundle
# (desktop/scripts/bundle-lab.mjs), checks it against the sha256 Mochi sends, unpacks it into the
# data folder's app/<stamp>/, and has the service manager run lab.mjs from it at every login,
# starting it again when it fails: launchd on macOS, systemd on Linux and in Windows's WSL2. One
# install serves every connection on this computer's account, and this adds the member's: their
# sign-in, kept in connections/<id>/ (lab.mjs's addConnection), which the running install starts
# without stopping the others. The install is replaced, and every connection restarted, only for a
# new bundle. Any failure stops it, with the reason.
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
LABEL=$("$UNPACKED/mochi-lab/bin/node" "$UNPACKED/mochi-lab/runner/lab.mjs" label) \
  || fail "the bundle could not say what to install as."
printf '%s' "$LABEL" | grep -Eq '^[A-Za-z0-9.-]+$' || fail "the bundle named no valid label."
if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  DATA="$HOME/.local/share/$LABEL"
  UNIT="$HOME/.config/systemd/user/$LABEL.service"
else
  DATA="$HOME/Library/Application Support/$LABEL"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  SERVICE="gui/$(id -u)/$LABEL"
fi
APPS="$DATA/app"
LOG="$DATA/logs/lab.log"
mkdir -p "$APPS" "$DATA/logs" || fail "could not make $DATA."

running() {
  if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
    systemctl --user is-active --quiet "$1.service"
  else
    launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
  fi
}
stop() {
  if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
    systemctl --user stop "$1.service" 2>/dev/null || true
  elif running "$1"; then
    launchctl bootout "gui/$(id -u)/$1" || fail "launchctl could not stop $1."
    waited=0
    while running "$1"; do
      [ "$waited" -lt 30 ] || fail "$1 did not stop within 30s."
      sleep 1
      waited=$((waited + 1))
    done
  fi
}

# Before one install served every connection, a development site's RUSH Lab was installed beside
# rush-lab.org's, as $LABEL.dev. Its connection was the development site's, so it is not kept.
if [ -d "$DATA.dev" ]; then
  echo "Removing the RUSH Lab installed for a development site beside this one..."
  stop "$LABEL.dev"
  if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
    systemctl --user disable "$LABEL.dev.service" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$LABEL.dev.service"
  else
    rm -f "$HOME/Library/LaunchAgents/$LABEL.dev.plist"
  fi
  rm -rf "$DATA.dev" || fail "could not remove $DATA.dev."
fi

# A new bundle, or an install from before connections, replaces the install, stopping every
# connection until it starts again; the same one is left running, and only this member's
# connection starts or restarts.
CURRENT=$(cat "$APPS/current/mochi-lab/stamp" 2>/dev/null || true)
if [ "$CURRENT" != "$STAMP" ] || [ -f "$DATA/runner-credentials.json" ]; then
  if running "$LABEL"; then
    echo "Stopping the RUSH Lab running on this computer now, to update it..."
    stop "$LABEL"
  fi
  rm -rf "${APPS:?}/$STAMP"
  mv "$UNPACKED" "$APPS/$STAMP" || fail "could not move the bundle into $APPS."
  ln -sfn "$STAMP" "$APPS/current"
  for old in "$APPS"/* "$APPS"/.*.partial; do
    [ -e "$old" ] || [ -L "$old" ] || continue
    case "$(basename "$old")" in
      "$STAMP" | current) ;;
      *) rm -rf "$old" || fail "could not remove $old." ;;
    esac
  done
  echo "Installed RUSH Lab $STAMP into $APPS/$STAMP."
else
  echo "RUSH Lab $STAMP is installed already."
fi
BUNDLE="$APPS/current/mochi-lab"

# The member's session, kept as their connection on this computer (lab.mjs addConnection): the link
# was theirs, signed in, so it connects with no sign-in page. A session that later lapses asks for one.
SESSION=$(curl -fsS -X POST "$SITE/api/lab/session?token=$TOKEN") || fail "$SITE gave no session for this computer."
# What the log held before, so the wait below reads only what this connection says from now.
SEEN=$(wc -l < "$LOG" 2>/dev/null || echo 0)
ID=$(LAB_SESSION="$SESSION" "$BUNDLE/bin/node" "$BUNDLE/runner/lab.mjs" connect "$DATA" "$SITE") \
  || fail "could not keep this member's connection in $DATA."

if [ "$TARGET" = x86_64-unknown-linux-gnu ]; then
  mkdir -p "$(dirname "$UNIT")" || fail "could not make $(dirname "$UNIT")."
  # Started again when it fails.
  cat > "$UNIT" <<UNITFILE || fail "could not write $UNIT."
[Unit]
Description=RUSH Lab: this computer's NanoAgent, lent to its members' runs

[Service]
ExecStart="$BUNDLE/bin/node" "$BUNDLE/runner/lab.mjs"
Restart=on-failure
RestartSec=30
# lab.mjs takes up to 10s to stop each service of each connection.
TimeoutStopSec=60
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
UNITFILE
  systemctl --user daemon-reload || fail "systemd could not read $UNIT."
  systemctl --user enable "$LABEL.service" >/dev/null 2>&1 || fail "systemd could not enable $LABEL.service."
  running "$LABEL" || systemctl --user start "$LABEL.service" || fail "systemd could not start $LABEL.service."
  UNINSTALL="systemctl --user disable --now $LABEL.service
  rm -rf \"$UNIT\" \"$DATA\""
else
  # Paths in the plist are XML text.
  xml() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
  }
  cat > "$PLIST" <<PLISTFILE || fail "could not write $PLIST."
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
  <!-- Started again when it fails. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <!-- lab.mjs takes up to 10s to stop each service of each connection. -->
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG")</string>
</dict>
</plist>
PLISTFILE
  plutil -lint "$PLIST" >/dev/null || fail "$PLIST is not a valid plist."
  running "$LABEL" || launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "launchctl could not start $PLIST."
  UNINSTALL="launchctl bootout $SERVICE
  rm -rf \"$PLIST\" \"$DATA\""
fi

# Until this connection is connected, or asks for a sign-in page after all, which opens in the
# browser where it can and is printed here too. The first start downloads Python.
said() {
  tail -n +"$((SEEN + 1))" "$LOG" 2>/dev/null | grep -F "[$ID] $1" | head -n 1
}
waited=0
PAGE=
CONNECTED=
while [ "$waited" -lt 180 ]; do
  [ -n "$(said 'Connected to')" ] && CONNECTED=1 && break
  PAGE=$(said 'Sign in to Mochi' | sed 's/.*: //') || true
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
  echo "It is still starting; $LOG says when [$ID] is connected."
fi
cat <<DONE
Logs: $LOG, and $DATA/connections/$ID/logs/ (nanoagent.log and relay.log)
To remove only this account's connection from this computer:
  rm -rf "$DATA/connections/$ID"
To uninstall RUSH Lab, every connection with it:
  $UNINSTALL
DONE
