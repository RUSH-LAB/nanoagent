# RUSH Lab: comparing nanoagent with other CLI agents

Run a task with **nanoagent**, then try to get the same result with another CLI agent (Claude Code, Codex, …), and compare **how often each succeeds** and **how efficiently**.

## 1. Install RUSH Lab

**macOS** (Terminal):
```sh
curl -fsSL https://rush-lab.org/install.sh | sh
```
**Windows** (PowerShell):
```powershell
irm https://rush-lab.org/install.ps1 | iex
```
RUSH Lab opens when the install finishes. Sign in. If it's already installed, accept the update it offers.

> The Harness terminal (step 4) needs an Apple silicon Mac, Windows or Linux. On an Intel Mac, steps 2–3 still work.

## 2. Open your plugin

In RUSH Lab, open **the plugin you created**. Its page has these tabs: **Session**, **Harness** and **Dashboard**.

## 3. Get a baseline with nanoagent

1. In the **Session** tab, give nanoagent your task (**your user prompt**). nanoagent is the only agent with your plugin's own tools.
2. Check the result: **did it complete the task the way you expected?** Do this a few times (e.g. 5 runs) and count the successes.
3. Open **Dashboard → `nanoagent`** for its efficiency, per session plus Total and Average: **End-to-End Latency, Model Time, Tool Time, Input/Output Tokens, Cost**.

## 4. Try another CLI agent in the Harness tab

1. Open **Harness**. A sandboxed terminal opens;
2. Run the agent you like: `claude`, `codex`, `pi`, `hermes`, `dsh` or `nanoagent`. Models and tracing are already set up, and every agent uses the same model (DeepSeek V4 Flash).
   - **Any other agent:** install it, then run it with `rush` in front the first time, e.g. `rush opencode`.
3. Quit the agent (or type `exit`) when you're done. Each conversation becomes a row under that agent's chip on the **Dashboard**, and clicking a row reopens it.

### 4a. Try to match nanoagent's results

- Use the same user prompt you gave nanoagent. If you want a system prompt too, paste it before the user prompt.
- Run it the same number of times as nanoagent (e.g. 5).

## 5. Report

For nanoagent and each agent you tried, fill in:

| Agent | Runs | Successes (as expected) | Success rate | Avg latency* | Avg model time | Avg input / output tokens | Avg cost |
|---|---|---|---|---|---|---|---|
| nanoagent | 5 | | | | | | |
| claude | 5 | | — | | | | |

\* Latency and tool time are measured only for nanoagent; for other agents, the Dashboard shows "—".

Also write down what you had to do (system prompt, extra setup) to get the other agent to succeed.

**Raw data:** **Dashboard → Download traces (JSON)** exports every model call, command and transcript of your own sessions.
