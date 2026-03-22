---
sidebar_position: 1
title: "Notification Sound for Claude Code"
---

# Notification Sound for Claude Code

When running multiple Claude Code sessions in VS Code, it's hard to tell which one finished. This guide sets up a macOS notification with sound that fires every time Claude finishes a response, showing which project completed.

---

## Prerequisites

Install [terminal-notifier](https://github.com/julienXX/terminal-notifier) via Homebrew:

```bash
brew install terminal-notifier
```

---

## Configuration

Add a `Stop` hook to `~/.claude/settings.json`. The `Stop` event fires every time Claude finishes responding, regardless of whether the terminal is focused.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "terminal-notifier -title 'Claude Code' -message \"Done in $(basename $PWD)\" -sound Glass -ignoreDnD"
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code after editing the file.

---

## What It Does

- **`-title 'Claude Code'`** — sets the notification title
- **`-message "Done in $(basename $PWD)"`** — shows the project folder name, so you know which session finished
- **`-sound Glass`** — plays the macOS Glass sound (alternatives: `Ping`, `Submarine`, `Hero`)
- **`-ignoreDnD`** — shows the notification even in Do Not Disturb mode

---

## macOS Notification Settings

After the first notification fires, go to **System Settings → Notifications → terminal-notifier** and configure:

- **Allow notifications**: On
- **Notification style**: Choose **Alerts** if you want the notification to stay on screen until dismissed. Choose **Banners** if you prefer it to disappear automatically.

---

## Why Not Other Approaches

| Approach | Problem |
|----------|---------|
| `Notification` hook | Only fires when the terminal is **not focused** — useless if you're watching |
| `printf '\a'` (terminal bell) | VS Code's integrated terminal doesn't show a visible indicator |
| `printf '\e]0;DONE\a'` (tab title) | Hook runs in a subprocess — stdout doesn't reach the terminal |
| `osascript display notification` | Shows a "Show" button that opens Script Editor |
| `terminal-notifier -sender com.microsoft.VSCode` | Routes notifications through VS Code's notification settings, which may be disabled |

---

## Customization

Change the sound:

```json
"command": "terminal-notifier -title 'Claude Code' -message \"Done in $(basename $PWD)\" -sound Ping -ignoreDnD"
```

Available macOS sounds: `Basso`, `Blow`, `Bottle`, `Frog`, `Funk`, `Glass`, `Hero`, `Morse`, `Ping`, `Pop`, `Purr`, `Sosumi`, `Submarine`, `Tink`.
