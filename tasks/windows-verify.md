# Verify RUSH Lab on Windows

A checklist to run on a real Windows PC. CI already builds the installer and runs `install.ps1` twice on a Windows runner (`.github/workflows/helpinghands-desktop.yml`). That runner has no person, no sign-in and no SmartScreen, so the checks below cover what it cannot.

Part A works now, with the build CI made from devmode. Part B needs devmode released to production, since rush-lab.org serves the Windows download, `install.ps1` and updates only after that.

For each step, write **pass** or **fail** in the table at the end. On a fail, add what you saw (a screenshot helps) and send the logs (step A9).

## Before you start

- Windows 10 or 11, 64-bit, signed in as a normal (not administrator) account.
- No RUSH Lab installed. If one is: Settings → Apps → Installed apps → RUSH Lab → Uninstall.
- A GitHub account that can see `RUSH-LAB/nanoagent` and sign in to rush-lab.org.

Run every PowerShell command in a normal PowerShell window (Start → type `PowerShell` → Windows PowerShell), not as administrator.

## Part A: the CI build, before release

This build opens on rush-lab.org, which is production and still behind devmode. A problem that comes from the site rather than the app may show up. Note it, but it does not fail the build. One is known: a site dialog (for example Trash → Empty) may error with `plugin:dialog|message not allowed by ACL` until devmode's dialog fix is released.

### A1. Get the installer

1. Open the build: https://github.com/RUSH-LAB/nanoagent/actions/runs/39091737667 (or the newest successful **Helping Hands desktop app** run).
2. Under **Artifacts**, download `rush-lab-x86_64-pc-windows-msvc`.
3. Unzip it. Inside is `RUSH Lab_<version>_x64-setup.exe` and its `.sig`.

### A2. Install by double-click

1. Double-click `RUSH Lab_<version>_x64-setup.exe`.
2. **Expect:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**. This is the warning the site's download text describes.
3. **Expect:** the installer finishes without asking for an administrator password, and RUSH Lab opens.
4. Check where it went:
   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\RUSH Lab"
   ```
   **Expect:** the app's `.exe`, `uninstall.exe`, and the `runner`, `nanoagent` and `git` folders.

### A3. Set up this computer

1. In RUSH Lab's window, **Sign in** with GitHub.
2. **Expect:** the steps **Sign in**, **Set up this computer** and **Open workspace** each turn done. Set up goes through install, Python, NanoAgent and connect. The first time takes a few minutes. Write down roughly how long.
3. **Expect:** no "could not be installed" or "Access is denied" message.

### A4. Run a plugin

1. Open your workspace and open the **arxiv-source** plugin.
2. Ask: `Get the LaTeX source of arXiv paper 2605.11086`.
3. **Expect:** it answers with the paper's source files, with no `McpError: Connection closed` and no `No module named plugin`.
4. **Expect:** Settings → Connection says this computer is connected.

### A5. The tray icon

1. Close RUSH Lab's window with its X.
2. **Expect:** RUSH Lab keeps running. Its icon is by the clock (it may be under the **^** arrow).
3. Right-click the icon. **Expect:** Open RUSH Lab, Show Logs, Quit RUSH Lab.
4. Click **Open RUSH Lab**. **Expect:** the window comes back, still signed in.
5. Click **Show Logs**. **Expect:** File Explorer opens `%LOCALAPPDATA%\lab.mochi.lab\logs`.

### A6. Install over the running app

1. With RUSH Lab running, double-click the same installer again.
2. **Expect:** it installs, and RUSH Lab opens again, still signed in and connected.

### A7. Quit leaves nothing running

1. Right-click the tray icon → **Quit RUSH Lab**. Wait 10 seconds.
2. Run:
   ```powershell
   Get-Process | Where-Object { $_.Path -like "$env:LOCALAPPDATA\RUSH Lab\*" }
   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*lab.mochi.lab*' } | Select-Object ProcessId, Name, CommandLine
   ```
   **Expect:** both print nothing. Anything left is an orphaned runner, which blocks the next install.

### A8. Opens at login

1. Restart Windows and sign in.
2. **Expect:** no window opens, but the tray icon is there. RUSH Lab started hidden, as at login.
3. Open it from the tray. **Expect:** still connected, and A4's plugin still answers.

### A9. Collect the logs

```powershell
Compress-Archive -Force "$env:LOCALAPPDATA\lab.mochi.lab\logs" "$HOME\Desktop\rush-lab-logs.zip"
```

Send `rush-lab-logs.zip` with the results table.

### A10. Uninstall

1. Settings → Apps → Installed apps → RUSH Lab → Uninstall.
2. **Expect:** `%LOCALAPPDATA%\RUSH Lab` is gone and the tray icon is gone. `%LOCALAPPDATA%\lab.mochi.lab`, the data folder with your sign-in and plugins, stays. That is expected.

## Part B: from rush-lab.org, after release

Do this once devmode is released to production and the **Helping Hands desktop app** run on `production` has uploaded the Windows build. Uninstall first (A10).

### B1. The landing page

1. In Edge or Chrome on the PC, open https://rush-lab.org.
2. **Expect:** the **Windows** tab is selected, with `irm https://rush-lab.org/install.ps1 | iex`, a Copy button and **Download for Windows**. No "coming soon".

### B2. Install with the command

1. Click **Copy**, paste into PowerShell, and press Enter.
2. **Expect:** `Downloading RUSH Lab...`, `Installing RUSH Lab...`, then `RUSH Lab is installed, and open: sign in in its window.` RUSH Lab opens.
3. **Expect:** no SmartScreen warning, and the PowerShell window stays open.
4. Sign in and run A4 again.

### B3. The command again, with RUSH Lab running

1. Run the same command again.
2. **Expect:** `Quitting the RUSH Lab that is running...` as well, then it installs and opens, still connected.

### B4. The download button

1. Uninstall (A10), then click **Download for Windows**.
2. **Expect:** `RUSH-Lab-Setup.exe` downloads, and A2's SmartScreen steps install it.

### B5. Self-update

This needs a second release after the one you installed from. Tell Claude when you get here, and it will make one.

1. Install from rush-lab.org (B2), sign in, then close the window, so RUSH Lab is only in the tray. Write down the installed version:
   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\RUSH Lab\*.exe" | Where-Object Name -ne 'uninstall.exe' | ForEach-Object { $_.VersionInfo.ProductVersion }
   ```
2. Once the next release's Windows build is uploaded, quit RUSH Lab from the tray and open it from the Start menu, so it checks at once (otherwise it checks hourly). Close its window again.
3. **Expect** within a few minutes, in `%LOCALAPPDATA%\lab.mochi.lab\logs\lab.log`: `Downloading RUSH Lab <new version>…`, then `Installing RUSH Lab <new version>…`. RUSH Lab disappears from the tray briefly and comes back, with no window.
4. Run step 1's command again. **Expect:** the new version.
5. Repeat with the window open. **Expect:** `Downloading…` appears, but `Installing…` waits until you close the window.

## Results

| Step | Result | Notes |
|---|---|---|
| A2 Install by double-click | | |
| A3 Set up (how long) | | |
| A4 Run a plugin | | |
| A5 Tray icon | | |
| A6 Install over running app | | |
| A7 Quit leaves nothing running | | |
| A8 Opens at login | | |
| A10 Uninstall | | |
| B1 Landing page | | |
| B2 Install with the command | | |
| B3 Command with RUSH Lab running | | |
| B4 Download button | | |
| B5 Self-update | | |

Windows version (Settings → System → About): ______
