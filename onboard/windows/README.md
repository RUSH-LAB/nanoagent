# Windows onboarding

`helpinghands/install.sh` supports macOS only (it uses Homebrew) and exits on Windows. Use `install.ps1` here instead.

## Install

From the project root, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File onboard\windows\install.ps1
```

It installs Node.js (LTS), Python 3.12, uv and PostgreSQL 18 with `winget`, then runs `npm ci` in `helpinghands/` and creates `.env` (`node scripts/dev/consolidate-env.mjs --initialize`).

## Next steps

Fill in the values in `helpinghands/.env` (see `helpinghands/scripts/README.md` for the GitHub values), then from `helpinghands/`:

```powershell
npm run db:setup
npm run db:pull
npm start
```

## RUSH Lab on this computer

Build the Windows app from `helpinghands/desktop/` with `npm run build:windows` (needs Rust and Visual Studio Build Tools), and run the installer it makes in `src-tauri/target/release/bundle/nsis/`.

The `npm` commands run from PowerShell or Git Bash. Open a new terminal after the install so `PATH` includes the new tools.
