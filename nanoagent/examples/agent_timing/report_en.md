# NanoAgent vs Claude Code on daily plugin tasks: time

Run on 2026-11-05 · Code: `nanoagent/examples/agent_timing/` (step1 builds the cases, step2 runs both agents, step3 scores them)

## Findings

1. **NanoAgent is faster on both tasks.** By the agent's working time (median):
   - Weather: 6.1s for NanoAgent vs 15.8s for Claude Code, about 2.6× faster.
   - Stocks: 42.0s vs 53.2s, about 21% faster.
2. **NanoAgent's time is far steadier.** On stocks, the p90 is 51.8s vs 238.9s. Claude Code writes its own script every time, and in 4 of 36 attempts that script fetched the 100 stocks one after another, taking 4–5 minutes. NanoAgent calls the plugin's own tool, which takes the same path every time.
3. **Accuracy is even:** 70/72 for NanoAgent and 70/72 for Claude Code. Both refused all 18 cases that should be refused. They fail differently:
   - NanoAgent (a small model) dropped an item while copying a long list, and once ended without submitting.
   - Claude Code twice computed the right answer but wrote it outside the folder it was given.
4. **Cost differs by about 160×:** across 90 attempts each, NanoAgent spent $0.09 in total and Claude Code $14.48. This is mostly model price (deepseek-v4-flash vs claude-opus-5-5), not framework efficiency.
5. **NanoAgent has an easy speedup waiting.** RUSH computes each run's reference answer with the reference tool first (about 31s on stocks) and only then starts the agent. That is why on stocks NanoAgent's **end-to-end** time is actually slower (72.9s vs 53.2s). Computing the reference alongside the agent would bring it down to about 42s.
6. **On the same model the gap is the framework's, and it is large.** With Claude Code also on deepseek-v4-flash (one round, 30 cases), NanoAgent took 7.9s vs 50.0s on weather and 43.6s vs 354.7s on stocks, and answered all 24 cases right, where Claude Code got 12/12 on weather but only 3/12 on stocks. Writing its own downloader and arithmetic is where a small model breaks down; the plugin's tools do that part for NanoAgent. See [Same model](#same-model-claude-code-on-deepseek-v4-flash).

## Setup

| | NanoAgent | Claude Code |
|---|---|---|
| How it runs | As RUSH Lab runs it: `run_task` pins the reference answer, the agent works the task with the plugin's tools, then calls `submit` | `claude -p`, launched through NanoAgent's Claude Code adapter, with its own tools (Bash, file writes, …) |
| Model | `deepseek/deepseek-v4-flash-0731` on OpenRouter, RUSH's default | `claude-opus-5-5`, the default of Claude Code 2.1.314 (confirmed from 908 transcript records) |
| Tools | The plugin's tools: `price_changes` (stocks), `city_weather` (weather) | No plugin tools; writes its own curl and Python |
| Input | The task's JSON input | The same input, plus the task description, the data sources (the Nasdaq API, Open-Meteo, and the 40 cities' coordinates) and the output schema. It is told to write its answer to `answer.json`, or `{"refused": ...}` |
| Limits | `max_steps: 10`, 900s per attempt | 900s per attempt |

**Cases:** 2 plugins with 15 cases each: 12 to answer and 3 to refuse. Each system ran every case 3 times, 180 attempts in all. Which system goes first rotates from case to case, so network and server load fall on both alike.

- **nasdaq-drops:** find the Nasdaq-100 stocks that fell at least X% over the last N trading days.
  - The end date is one of 9 trading days in October; N is 1–10; X is 2%–10%.
  - Right answers hold 4 to 46 stocks.
  - Cases to refuse: an end date on a Sunday, on a Saturday, or in the future.
- **city-weather:** among 40 cities, find those whose precipitation, maximum or minimum temperature on a given day is at least / at most a threshold.
  - The date is one of 12 days in October.
  - Right answers hold 0 to 21 cities; two of them are empty lists.
  - Cases to refuse: a date in the future (two), or in 1930, before the data source's range.

**Scoring:** the plugin's own verifier (deterministic code, no LLM judge) checks each answer against the reference answer pinned in step 1. A case to refuse is correct when the agent refused it.

**Timing:** one clock outside both systems times each whole attempt. "Agent time" is that total minus the time NanoAgent spends pinning its reference first; Claude Code has no such step. "Model share" comes from each system's own report of its time on the model's API: `profile.model_s` for NanoAgent, `duration_api_ms` for Claude Code.

## Results

Cases to answer only: 36 attempts per row. Cases to refuse are counted separately, 9 per row.

| Plugin | System | Correct | Refused right | Agent mean | Agent p50 | Agent p90 | Model share | Seconds per correct answer | Mean cost per attempt |
|---|---|---|---|---|---|---|---|---|---|
| city-weather | NanoAgent | 35/36 | 9/9 | **7.4s** | **6.1s** | **10.2s** | 80% | **6.2s** | $0.001 |
| city-weather | Claude Code | 36/36 | 9/9 | 17.8s | 15.8s | 20.8s | 83% | 16.8s | $0.151 |
| nasdaq-drops | NanoAgent | 35/36 | 9/9 | **43.6s** | **42.0s** | **51.8s** | 25% | **36.8s** | $0.001 |
| nasdaq-drops | Claude Code | 34/36 | 9/9 | 75.8s | 53.2s | 238.9s | 29% | 65.2s | $0.171 |

"Seconds per correct answer" is the agent time of every attempt, failed ones included, divided by the number of correct ones.

The median agent time is close from round to round, so the result is steady, not one lucky round:

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| nasdaq NanoAgent | 40.5s | 42.5s | 42.3s |
| nasdaq Claude Code | 51.9s | 56.4s | 51.9s |
| weather NanoAgent | 6.0s | 5.8s | 7.8s |
| weather Claude Code | 15.7s | 17.5s | 15.8s |

## Where the time goes

Medians over cases to answer, by each system's own clock:

| | Reference | Model | Tools and other | Steps |
|---|---|---|---|---|
| nasdaq NanoAgent | 31.1s | 9.3s | 30.8s | 3 |
| nasdaq Claude Code | — | 19.4s | 33.0s | 4 |
| weather NanoAgent | 1.4s | 4.6s | 1.4s | 3 |
| weather Claude Code | — | 13.8s | 1.6s | 3 |

- **Stocks are bound by fetching data.** Both systems pull 100 stocks' price history, and their tool time is about the same (31s vs 33s). NanoAgent fetches with 8 threads; Claude Code, when it behaves, also fetches in parallel. So the gap in agent time comes mostly from the model (9s vs 19s): NanoAgent calls one ready-made tool, while Claude Code first probes the API, writes a script and checks its output.
- **Weather is bound by the model.** One request returns all 40 cities, so model time is nearly the whole run. NanoAgent's model is smaller and faster and writes no code, so it is 2.6× faster.
- **NanoAgent's total includes a second fetch.** On stocks, the reference and the agent each download the same 100 stocks. That is how RUSH runs a task today: the reference first, then the agent.

## Cases to refuse

| | NanoAgent p50 | Claude Code p50 |
|---|---|---|
| nasdaq-drops | 7.0s | 7.9s |
| city-weather | 0.6s | 11.6s |

The two systems refuse differently. NanoAgent's refusal comes from the plugin's **reference tool**, which fails before the agent starts, e.g. "Nasdaq has no close for AAPL on 2026-10-25: as_of must be a trading day". So this measures how fast the plugin checks its input, not the agent's judgement. A weekend date takes 7–9s, because the reference tool must fetch AAPL's history before it sees there is no close that day; a future date takes 0.5s. Claude Code decides with its model and writes `{"refused": ...}`.

## Failures

| Attempt | System | What happened | Why |
|---|---|---|---|
| nasdaq-drops-07 #1, nasdaq-drops-08 #1 | Claude Code | `Claude Code wrote no answer.json` | Claude Code `cd`'d into folders it made under `/tmp/ndq` and `/tmp/nd` and wrote its answers there (both right, with 20 and 22 stocks), while its reply said "I wrote answer.json". **It did the task but did not deliver it as asked.** |
| nasdaq-drops-12 #1 | NanoAgent | The answer is missing CEG (−7.2%) | The right answer has 46 stocks. The tool returned all 100 stocks' changes, and the model dropped one while copying them out. A small model copying a long list by hand makes mistakes. |
| city-weather-06 #1 | NanoAgent | Ended without calling submit | The right answer is an empty list (no city's minimum on October 5 was ≤ 0°C). The other two rounds submitted the empty list correctly. The refusal path saves no transcript, so the cause can't be confirmed; most likely the model took "nothing found" to mean "nothing to submit". |

**Claude Code's long tail:** its 4 slowest attempts (239s, 243s, 269s and 284s: nasdaq-06 #3, 10 #2, 04 #3 and 11 #2) all fetched the 100 stocks serially. The other 32 fetched in parallel. Leaving out the 2 failed to deliver, those 30 have a median of 52.6s and a maximum of 99s. In the slow 4 the model took only 18–38s; the rest was waiting on one request after another. Writing new code every time makes Claude Code's implementation uneven, and that is the root of its spread in time.

## Same model: Claude Code on deepseek-v4-flash

The same 30 cases, one round, with Claude Code's requests sent to OpenRouter's Anthropic-compatible API (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`) and `--model deepseek/deepseek-v4-flash-0731`, NanoAgent's model. Everything else is as above: the same prompt, its own tools, `bypassPermissions`, 900s. Every model record in its transcripts names deepseek-v4-flash. Its cost is counted from its tokens at OpenRouter's prices, since Claude Code prices every model as Claude.

| Plugin | System | Correct | Refused right | Agent mean | Agent p50 | Agent p90 | Steps p50 | Total cost |
|---|---|---|---|---|---|---|---|---|
| city-weather | NanoAgent | **12/12** | 3/3 | **8.6s** | **7.9s** | **9.9s** | 3 | $0.008 |
| city-weather | Claude Code (flash) | **12/12** | 3/3 | 50.4s | 50.0s | 64.5s | 6 | $0.130 |
| nasdaq-drops | NanoAgent | **12/12** | 3/3 | **42.6s** | **43.6s** | **49.3s** | 3 | $0.022 |
| nasdaq-drops | Claude Code (flash) | 3/12 | 3/3 | 381.4s | 354.7s | 632.7s | 21 | $0.543 |

Where the time goes (median, each system's own clock):

| | Reference | Model | Tools and other |
|---|---|---|---|
| nasdaq NanoAgent | 30.9s | 12.2s | 30.4s |
| nasdaq Claude Code (flash) | — | 103.3s | 220.0s |
| weather NanoAgent | 1.4s | 6.5s | 1.3s |
| weather Claude Code (flash) | — | 26.7s | 23.5s |

- **Weather:** 6.3× slower than NanoAgent on the same model, where Opus was 2.6× slower. Both answered every case right.
- **Stocks:** 8.1× slower (9s to 831s). 10 of the 11 attempts that did the work fetched the 100 stocks serially; 9 commands hit Claude Code's 120s limit for one Bash command and went to the background, after which it polled with `sleep` loops (17 of them). With Opus, 32 of 36 attempts fetched in parallel.
- **Its 9 wrong stock answers:**

| Cause | Cases |
|---|---|
| Window starts one trading day late, though the prompt says it "starts on the trading day N sessions before as_of" | 01, 05, 07, 11 |
| Right stocks and numbers, but each company name stripped of the trailing space Nasdaq's name has | 04, 09, 10 |
| Drops not sorted largest first | 08 |
| Its first and only turn was unrelated text, with no tool call and no answer | 12 |

  The verifier compares names exactly as Nasdaq lists them, so 04, 09 and 10 are wrong under its rule; counted loosely they would make 6/12.
- **Refusals** are right on both: NanoAgent's from the reference tool (0.4–7.1s), Claude Code's by its model (6.1–26.5s).
- **`/tmp`:** flash wrote to fixed names such as `/tmp/aapl.json` and `/tmp/ndx.json` that earlier attempts had used too. In every such case the transcript shows the later attempt downloading or writing the file afresh before reading it, so no attempt used another's data.
- **Run notes:** 3 rounds were planned and cut to 1 for time. The Mac slept for 10 minutes during nasdaq-drops-09's Claude Code attempt (lid closed on battery); that attempt was discarded and run again after the round, not in its turn.

## Limitations

- **Different models in the main run:** the main comparison takes each system as it comes out of the box, not the frameworks on one model; much of its cost gap and of its weather speed gap comes from the model. The same-model run above isolates the framework, but on one round only.
- **Claude Code's `/tmp` is shared:** attempts used folders of the same name (`/tmp/ndx`, `/tmp/ndq`, …). I checked all 45 of Claude Code's stock transcripts: every attempt that answered downloaded the history itself, and no script skipped a file that already existed, so **there is no sign it reused another attempt's data**. Still, the shared names are a risk; next time each attempt should get its own temporary folder (e.g. by setting `TMPDIR`).
- **Round 3 ran in two parts:** the first 132 attempts ran from 05:42 to 07:10 UTC, and the remaining 48 about 10 hours later, 17:08–17:23 UTC. The systems kept taking turns across the break, and each round's medians agree.
- **Limited coverage:** 2 plugins and 30 cases, all of the "fetch data, then filter" kind. The Nasdaq-100 members are today's list.
- **Claude Code's prompt names the data sources and APIs.** Without them it would be slower and more error-prone.

## Improvements

1. **Compute the reference alongside the agent** (`_run` in `nanoagent/src/nanoagent/plugin/tasks.py`). Stocks' total time should drop from 73s to about 42s, ahead of Claude Code.
2. **Raise the plugin's fetch concurrency from 8 to 32** (`WORKERS` in `nasdaq-drops/src/plugin/changes.py`). Measured, fetching drops from 27s to 10.5s, which helps both the reference and the agent.
3. **Have a tool return the filtered result directly**, e.g. give the agent's tool a `min_drop_percent` parameter, so the model never copies a long list. That removes misses like nasdaq-12's and shortens model time.
4. **Save the transcript on the refusal path too**, to diagnose cases like city-weather-06.

## Reproduce

From the repository root. NanoAgent needs `OPENROUTER_API_KEY`; Claude Code uses the computer's logged-in account.

```bash
bash nanoagent/examples/agent_timing/runs/step1_build_cases.sh
bash nanoagent/examples/agent_timing/runs/step2_run_agents.sh out-of-box   # running it again after a stop resumes it
bash nanoagent/examples/agent_timing/runs/step3_score.sh out-of-box
bash nanoagent/examples/agent_timing/runs/step2_run_agents.sh same-model repeats=1
bash nanoagent/examples/agent_timing/runs/step3_score.sh same-model
```

Each attempt's details are in `outputs/step2_run_agents/out-of-box/runs/<case>/<system>-<repeat>/`:
- `attempt.json`: the attempt's record.
- NanoAgent's `messages.json`: its transcript in ATIF.
- Claude Code's `reply.txt` and `workspace/`.

Scores are in `outputs/step3_score/out-of-box/scores.json`.
