# RUSH Lab: nanoagent vs. other CLI agents

**Goal:** run your plugin's task with **nanoagent**, then try other CLI agents (Claude Code, Codex, …) on the same task. Compare **how often each gets the result you expect** and **how efficiently** (time, tokens, cost).

Everything you run in RUSH Lab is recorded automatically, so you don't need to log anything yourself.

## 1. Install RUSH Lab

- **macOS** (Terminal): `curl -fsSL https://rush-lab.org/install.sh | sh`
- **Windows** (PowerShell): `irm https://rush-lab.org/install.ps1 | iex`

RUSH Lab opens when the install finishes. Sign in. If you already have it, accept the update it offers.

> Step 4 (the Harness terminal) needs an Apple silicon Mac or Windows. On an Intel Mac you can still do step 3.

## 2. Open your plugin

Open **the plugin you created**. You'll use three tabs:

- **Session:** chat with nanoagent.
- **Harness:** a terminal where you run other agents.
- **Dashboard:** the results and numbers for every run.

## 3. Baseline: nanoagent

1. In **Session**, give nanoagent your task (your **user prompt**). nanoagent is the only agent that has your plugin's own tools.
2. Check the answer: **did it do what you expected?**
3. Repeat **5 times** (start a new session each time) and count the successes.
4. Open **Dashboard → `nanoagent`** to see its numbers: latency, model time, tool time, input/output tokens, cost.

## 4. Other agents in the Harness tab

**How to run one:** open **Harness**, then type the agent's name: `claude`, `codex`, `pi`, `hermes` or `dsh`. They're already set up, and all of them use the same model as nanoagent (DeepSeek V4 Flash). Type `exit` when you're done. Each conversation appears under that agent's name on the **Dashboard**.

**Want a different agent?** Install it in the terminal, then put `rush` in front of it the first time, e.g. `rush opencode`. From then on, plain `opencode` is recorded too.

### 4a. Match nanoagent

- Use the **same user prompt** you gave nanoagent. To add a system prompt, paste it before the user prompt.
- Run it **5 times**, and count the successes.

### 4b. Beat nanoagent

- Use **any agent, any way you like**, to match or beat nanoagent's results and efficiency.
- Not allowed: copying nanoagent, or giving the agent the answer directly.
- Write down **what you tried, and why**.
- If nanoagent is hard to beat, explain why, or open a PR that improves nanoagent.

## 5. Report

**a. Fill in this table** for nanoagent and each agent you tried. Take the numbers from the **Dashboard**.

| Agent | Runs | Successes | Success rate | Avg latency* | Avg model time | Avg input / output tokens | Avg cost |
|---|---|---|---|---|---|---|---|
| nanoagent | 5 | | | | | | |
| claude | 5 | | | — | | | |

\* Only nanoagent's latency is measured. Other agents show "—".

**b. Write down** what you did in 4a and 4b: prompts, setup, what worked and what didn't.

**c. Attach your traces:**
1. **Dashboard → Download traces (JSON)**
2. Zip the downloaded file. On a Mac, right-click it → **Compress**. On Windows, right-click it → **Compress to ZIP file**.
3. Upload the `.zip` with your report.
