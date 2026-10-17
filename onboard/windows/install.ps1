$ErrorActionPreference = "Stop"

winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
winget install --id PostgreSQL.PostgreSQL.18 -e --accept-source-agreements --accept-package-agreements

# Refresh PATH in this session so the new tools are found.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

Set-Location (Join-Path $PSScriptRoot "..\..\helpinghands")
node --version
npm --version
uv --version
npm ci
node scripts/dev/consolidate-env.mjs --initialize
