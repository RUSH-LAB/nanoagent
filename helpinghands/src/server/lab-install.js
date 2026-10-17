'use strict';

// Where the script is: curl -fsSL <SITE_URL>/install.sh | sh (routes/lab.js).
const INSTALL_PATH = '/install.sh';

/**
 * The script `curl -fsSL <site>/install.sh | sh` runs: it installs RUSH Lab on this Mac from
 * `site` and opens it, quitting the one running first, as only one runs at a time. A download
 * curl makes is not quarantined, so macOS opens the app without asking to allow it (Open Anyway).
 * The dmg is checked against the sha256 the site sends with it.
 */
function installScript(site) {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(site)) throw new Error(`SITE_URL ${site} is not a site the install script can name`);
  return `#!/bin/sh
# Installs RUSH Lab from ${site}: curl -fsSL ${site}${INSTALL_PATH} | sh
set -eu
SITE='${site}'
APP='/Applications/RUSH Lab.app'

fail() { echo "RUSH Lab was not installed: $1" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this command is for macOS. Download RUSH Lab from $SITE/download"
# An Apple silicon Mac says so even to a shell that runs under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then TARGET=aarch64-apple-darwin; else TARGET=x86_64-apple-darwin; fi

WORK=$(mktemp -d)
trap 'hdiutil detach -quiet "$WORK/disk" 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "Downloading RUSH Lab..."
curl -fSL --progress-bar -D "$WORK/headers" -o "$WORK/RUSH-Lab.dmg" "$SITE/api/lab/bundles/$TARGET" || fail "it could not be downloaded from $SITE"
EXPECTED=$(tr -d '\\r' < "$WORK/headers" | awk 'tolower($1) == "x-lab-sha256:" { print $2 }' | tail -n 1)
ACTUAL=$(shasum -a 256 "$WORK/RUSH-Lab.dmg" | awk '{ print $1 }')
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "the download is damaged (sha256 $ACTUAL, expected $EXPECTED). Run the command again"

hdiutil attach -quiet -nobrowse -readonly -mountpoint "$WORK/disk" "$WORK/RUSH-Lab.dmg" || fail "its disk image did not open"

# One RUSH Lab runs at a time; it takes up to a minute to stop.
if pgrep -f 'RUSH Lab.app/Contents/MacOS/' > /dev/null; then
  echo "Quitting the RUSH Lab that is running..."
  osascript -e 'quit app id "lab.mochi.lab"' > /dev/null
  waited=0
  while pgrep -f 'RUSH Lab.app/Contents/MacOS/' > /dev/null; do
    [ "$waited" -lt 90 ] || fail "the RUSH Lab running did not quit. Quit it from its menu-bar icon, then run the command again"
    sleep 1
    waited=$((waited + 1))
  done
fi

rm -rf "$APP" || fail "$APP could not be replaced"
ditto "$WORK/disk/RUSH Lab.app" "$APP" || fail "it could not be copied into /Applications"
open "$APP"
echo "RUSH Lab is installed in Applications, and open: sign in in its window."
`;
}

module.exports = {INSTALL_PATH, installScript};
