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

## RUSH Lab on this computer (the `curl ... | sh` command)

The site's install command runs plugins in a bubblewrap sandbox under a systemd user service, so it cannot run in PowerShell. Run it inside WSL2 (Ubuntu), which needs:

- `systemd=true` under `[boot]` in Ubuntu's `/etc/wsl.conf`, and `bubblewrap` and `curl` installed (`sudo apt install bubblewrap curl`).
- `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`. Ubuntu can then reach the site on Windows' `localhost:3000`, which the command's URL uses. `npm start` binds the site to `127.0.0.1` for this.

Then open Ubuntu (`wsl -d Ubuntu`), and paste the command from the site there. Its token lasts an hour, so copy a fresh one if it fails.

The `npm` commands run from PowerShell or Git Bash. Open a new terminal after the install so `PATH` includes the new tools.
