'use strict';

/**
 * The script `curl -fsSL <site>/install.sh | sh` runs: it installs RUSH Lab on this Mac from
 * `site` and opens it, quitting the one running first, as only one runs at a time. A download
 * curl makes is not quarantined, so macOS opens the app without asking to allow it (Open Anyway).
 * The dmg is checked against the sha256 the site sends with it.
 */
function macScript(site) {
  checkSite(site);
  return `#!/bin/sh
# Installs RUSH Lab from ${site}: curl -fsSL ${site}/install.sh | sh
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

/**
 * The script `irm <site>/install.ps1 | iex` runs in PowerShell: it installs RUSH Lab for this
 * Windows user from `site` and opens it, quitting the one running first, with every service it
 * started, as only one runs at a time. A download PowerShell makes has no mark of the web, so
 * SmartScreen does not stop the installer. The installer is checked against the sha256 the site
 * sends with it. It runs in the member's own PowerShell, so it throws rather than exits, which
 * would close their window.
 */
function windowsScript(site) {
  checkSite(site);
  return `# Installs RUSH Lab from ${site}: irm ${site}/install.ps1 | iex
& {
$ErrorActionPreference = 'Stop'
# Windows PowerShell draws its progress so slowly that it slows the download.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Site = '${site}'
# Where the installer puts RUSH Lab for this user (tauri.conf.json: nsis installMode currentUser).
$Folder = Join-Path $env:LOCALAPPDATA 'RUSH Lab'

function Fail($Why) { throw "RUSH Lab was not installed: $Why" }
function Running { @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$Folder\\", 'OrdinalIgnoreCase') }) }

if (-not [Environment]::Is64BitOperatingSystem) { Fail "it needs 64-bit Windows" }

$Work = Join-Path ([IO.Path]::GetTempPath()) ('rush-lab-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  $Setup = Join-Path $Work 'RUSH-Lab-Setup.exe'
  Write-Host 'Downloading RUSH Lab...'
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Uri "$Site/api/lab/bundles/x86_64-pc-windows-msvc" -OutFile $Setup -PassThru
  } catch {
    Fail "it could not be downloaded from $Site"
  }
  $Expected = @($Response.Headers['X-Lab-Sha256'])[0]
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $Setup).Hash.ToLowerInvariant()
  if (-not $Expected -or $Expected -ne $Actual) { Fail "the download is damaged (sha256 $Actual, expected $Expected). Run the command again" }

  # One RUSH Lab runs at a time: the one running stops with every service it started.
  if ((Running).Count -gt 0) {
    Write-Host 'Quitting the RUSH Lab that is running...'
    foreach ($Process in Running) { cmd /c "taskkill /PID $($Process.Id) /T /F >nul 2>&1" }
    $Waited = 0
    while ((Running).Count -gt 0) {
      if ($Waited -ge 30) { Fail "the RUSH Lab running did not quit. Quit it from its icon by the clock, then run the command again" }
      Start-Sleep -Seconds 1
      $Waited++
    }
  }

  Write-Host 'Installing RUSH Lab...'
  # /S installs with no questions; /R opens RUSH Lab once it is installed.
  $Installer = Start-Process -FilePath $Setup -ArgumentList '/S', '/R' -PassThru
  # Windows PowerShell keeps the exit code only once the handle is asked for.
  $null = $Installer.Handle
  $Installer.WaitForExit()
  if ($Installer.ExitCode -ne 0) { Fail "its installer stopped with exit code $($Installer.ExitCode)" }
  Write-Host 'RUSH Lab is installed, and open: sign in in its window.'
} finally {
  Remove-Item -Recurse -Force -Path $Work -ErrorAction SilentlyContinue
}
}
`;
}

/** Throw unless `site` is an origin the scripts can quote as it is. */
function checkSite(site) {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(site)) throw new Error(`SITE_URL ${site} is not a site the install script can name`);
}

// Each install script by its path (routes/lab.js), with its content type.
const INSTALL_SCRIPTS = new Map([
  ['/install.sh', {type: 'text/x-shellscript', script: macScript}],
  ['/install.ps1', {type: 'text/plain', script: windowsScript}],
]);

module.exports = {INSTALL_SCRIPTS, macScript, windowsScript};
