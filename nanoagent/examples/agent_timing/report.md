# NanoAgent 与 Claude Code 完成插件日常任务的用时对比

实验日期：2026-11-05 · 代码：`nanoagent/examples/agent_timing/`（step1 生成题目，step2 运行两个 agent，step3 打分）

## 结论

1. **两类任务都是 NanoAgent 更快。** 只算 agent 干活的时间（中位数）：
   - 天气任务：NanoAgent 6.1s，Claude Code 15.8s，快约 2.6 倍。
   - 股票任务：NanoAgent 42.0s，Claude Code 53.2s，快约 21%。
2. **NanoAgent 的用时更稳定。** 股票任务的 p90 是 51.8s 对 238.9s。Claude Code 每次都要现场写脚本，36 次里有 4 次写成了逐只股票串行下载，每次要花 4 到 5 分钟。NanoAgent 调用的是插件自带的工具，每次走的都是同一条路径。
3. **正确率持平：** NanoAgent 70/72，Claude Code 70/72。该拒绝的 18 道题，两边全部拒绝。两边错法不同：
   - NanoAgent（小模型）抄长列表时漏了一项，还有一次没提交就结束了。
   - Claude Code 有两次算对了答案，却把它写到了指定目录之外。
4. **成本差约 160 倍：** 90 次运行，NanoAgent 共花 $0.09，Claude Code 共花 $14.48。这主要是模型价格的差别（deepseek-v4-flash 对 claude-opus-5-5），并不说明框架更高效。
5. **NanoAgent 有一处现成的提速空间。** RUSH 每次运行都会先用参考工具算一遍标准答案（股票任务约 31s），然后 agent 再干活。所以股票任务从开始到结束的**总时间**，反而是 NanoAgent 慢（72.9s 对 53.2s）。如果让参考答案和 agent 并行计算，总时间可以降到约 42s。
6. **同模型下，差距来自框架，而且很大。** 让 Claude Code 也用 deepseek-v4-flash（30 道题，跑 1 轮）：
   - 天气：NanoAgent 7.9s，Claude Code 50.0s。
   - 股票：NanoAgent 43.6s，Claude Code 354.7s。
   - 正确率：NanoAgent 24 道全对。Claude Code 天气 12/12，股票只有 3/12。
   - 原因：小模型自己写下载脚本、自己做计算时最容易出错，而 NanoAgent 这部分交给了插件工具。详见[同模型对比](#同模型对比claude-code-使用-deepseek-v4-flash)。

## 实验设置

| | NanoAgent | Claude Code |
|---|---|---|
| 运行方式 | 和 RUSH Lab 一样：`run_task` 先算好参考答案，agent 用插件的工具完成任务，再调用 `submit` | `claude -p`，通过 NanoAgent 的 Claude Code 适配器启动，用的是它自带的工具（Bash、写文件等） |
| 模型 | `deepseek/deepseek-v4-flash-0731`，走 OpenRouter，是 RUSH 的默认模型 | `claude-opus-5-5`，Claude Code 2.1.314 的默认模型，从 908 条转录记录中确认 |
| 工具 | 插件工具：`price_changes`（股票）、`city_weather`（天气） | 没有插件工具，自己写 curl 和 Python |
| 输入 | 任务的 JSON 输入 | 同一份输入，外加任务描述、数据源说明（Nasdaq API、Open-Meteo，以及 40 个城市的坐标）和输出 schema。要求把答案写到 `answer.json`，或者写 `{"refused": ...}` |
| 上限 | `max_steps: 10`，每次 900s | 每次 900s |

**题目：** 2 个插件，每个 15 道，其中 12 道应该作答、3 道应该拒绝。每道题两个系统各跑 3 轮，一共 180 次。每道题由哪个系统先跑是轮换的，这样网络和服务端的负载对两边一样。

- **nasdaq-drops：** 找出过去 N 个交易日里跌幅至少 X% 的纳斯达克 100 成分股。
  - 截止日期取 10 月里的 9 个交易日；N 取 1 到 10 天；X 取 2% 到 10%。
  - 正确答案有 4 到 46 只股票。
  - 应拒绝的题：截止日期是周日、周六，或者在未来。
- **city-weather：** 在 40 个城市里，找出某天降水、最高温或最低温满足 “≥ / ≤ 某个阈值” 的城市。
  - 日期取 10 月里的 12 天。
  - 正确答案有 0 到 21 个城市，其中两题的答案是空列表。
  - 应拒绝的题：日期在未来（两道），或者是 1930 年，超出了数据源的范围。

**打分：** 用插件自己的 verifier（确定性代码，不用 LLM 打分），把答案和 step1 预先算好的参考答案对比。拒绝类的题，只要拒绝了就算对。

**计时：** 外部时钟记录每次运行的总时间。“agent 用时” 等于总时间减去 NanoAgent 预先算参考答案的时间，Claude Code 没有这一步。“模型占比” 来自各系统自己报告的模型 API 时间：NanoAgent 用的是 `profile.model_s`，Claude Code 用的是 `duration_api_ms`。

## 主要结果

只统计应作答的题，每格是 36 次运行；拒绝类的题另算，每格 9 次。

| 插件 | 系统 | 正确 | 拒绝正确 | agent 平均 | agent p50 | agent p90 | 模型占比 | 每个正确答案的用时 | 每次平均成本 |
|---|---|---|---|---|---|---|---|---|---|
| city-weather | NanoAgent | 35/36 | 9/9 | **7.4s** | **6.1s** | **10.2s** | 80% | **6.2s** | $0.001 |
| city-weather | Claude Code | 36/36 | 9/9 | 17.8s | 15.8s | 20.8s | 83% | 16.8s | $0.151 |
| nasdaq-drops | NanoAgent | 35/36 | 9/9 | **43.6s** | **42.0s** | **51.8s** | 25% | **36.8s** | $0.001 |
| nasdaq-drops | Claude Code | 34/36 | 9/9 | 75.8s | 53.2s | 238.9s | 29% | 65.2s | $0.171 |

“每个正确答案的用时” 等于所有运行（包括失败的）的 agent 用时之和，除以正确的次数。

每一轮的 agent 用时中位数都很接近，说明结果是稳定的，不是某一轮碰巧：

| | 第 1 轮 | 第 2 轮 | 第 3 轮 |
|---|---|---|---|
| nasdaq NanoAgent | 40.5s | 42.5s | 42.3s |
| nasdaq Claude Code | 51.9s | 56.4s | 51.9s |
| weather NanoAgent | 6.0s | 5.8s | 7.8s |
| weather Claude Code | 15.7s | 17.5s | 15.8s |

## 时间花在哪里

下表是应作答题的中位数，按各系统自己的时钟统计：

| | 参考答案 | 模型 | 工具及其他 | 步数 |
|---|---|---|---|---|
| nasdaq NanoAgent | 31.1s | 9.3s | 30.8s | 3 |
| nasdaq Claude Code | — | 19.4s | 33.0s | 4 |
| weather NanoAgent | 1.4s | 4.6s | 1.4s | 3 |
| weather Claude Code | — | 13.8s | 1.6s | 3 |

- **股票任务主要耗在下载数据上。** 两边都要拉 100 只股票的历史行情，工具时间差不多（约 31s 对 33s）。NanoAgent 用 8 个线程并发下载；Claude Code 正常的时候也是并行下载。所以两边 agent 用时的差距，主要来自模型时间（9s 对 19s）：NanoAgent 直接调一个现成的工具，Claude Code 得先探查 API、写脚本、再检查结果。
- **天气任务主要耗在模型上。** 一次请求就能拿到 40 个城市的数据，所以模型时间几乎就是全部用时。NanoAgent 的模型更小、更快，再加上不用自己写代码，所以快了 2.6 倍。
- **NanoAgent 的总时间里包含一遍重复下载。** 股票任务里，参考答案和 agent 各下载了一次同样的 100 只股票数据。这是 RUSH 现在的运行方式：先算好参考答案，再让 agent 开始。

## 拒绝类题目

| | NanoAgent p50 | Claude Code p50 |
|---|---|---|
| nasdaq-drops | 7.0s | 7.9s |
| city-weather | 0.6s | 11.6s |

这两边的拒绝方式不一样。NanoAgent 的拒绝来自插件的**参考工具**：它在 agent 启动之前就报错了，比如 “Nasdaq has no close for AAPL on 2026-10-25: as_of must be a trading day”。所以这里测的是插件的校验速度，不是 agent 的判断。拒绝周末日期要 7 到 9s，因为参考工具要先下载 AAPL 的数据才能发现那天没有收盘价；拒绝未来日期只要 0.5s。Claude Code 则要靠模型自己判断，并写出 `{"refused": ...}`。

## 失败案例

| 运行 | 系统 | 现象 | 原因 |
|---|---|---|---|
| nasdaq-drops-07 #1、nasdaq-drops-08 #1 | Claude Code | `Claude Code wrote no answer.json` | Claude Code `cd` 到了自己在 `/tmp/ndq`、`/tmp/nd` 下建的目录，把答案写在了那里（内容是对的，分别是 20 只和 22 只），回复里却说 “I wrote answer.json”。这属于**没按要求交付**。 |
| nasdaq-drops-12 #1 | NanoAgent | 答案漏了 CEG（−7.2%） | 正确答案有 46 只股票。工具返回了全部 100 只的涨跌幅，模型逐条抄写时漏了一只。小模型手抄长列表容易出错。 |
| city-weather-06 #1 | NanoAgent | 没调用 submit 就结束了 | 这题的正确答案是空列表（10 月 5 日没有城市最低温 ≤ 0°C）。另外两轮都正确提交了空列表。拒绝路径下没有保存对话记录，无法进一步确认原因，推测是模型把 “没有结果” 当成了 “不用提交”。 |

**Claude Code 的长尾：** 用时排前 4 的运行（239s、243s、269s、284s，分别是 nasdaq-06 #3、10 #2、04 #3、11 #2），全部是串行下载 100 只股票的情况。其余 32 次都是并行下载。除去交付失败的 2 次，剩下 30 次的中位数是 52.6s，最慢 99s。这几次的模型时间只有 18 到 38s，其余都花在了等串行请求上。Claude Code 每次现场写代码，实现质量就不稳定，这是它用时方差大的根本原因。

## 同模型对比：Claude Code 使用 deepseek-v4-flash

**设置：**
- 题目：同样的 30 道题，跑 1 轮。
- 模型：把 Claude Code 的请求转到 OpenRouter 的 Anthropic 兼容接口（`ANTHROPIC_BASE_URL=https://openrouter.ai/api`），用 `--model deepseek/deepseek-v4-flash-0731`，和 NanoAgent 用同一个模型。每次运行的对话记录里，模型都是 deepseek-v4-flash。
- 其他条件不变：同样的提示，用它自己的工具，`bypassPermissions`，每次上限 900s。
- 成本：Claude Code 会按 Claude 的价格给所有模型算钱，所以这里改成按 token 数和 OpenRouter 的价格来算。

| 插件 | 系统 | 正确 | 拒绝正确 | agent 平均 | agent p50 | agent p90 | 步数 p50 | 总成本 |
|---|---|---|---|---|---|---|---|---|
| city-weather | NanoAgent | **12/12** | 3/3 | **8.6s** | **7.9s** | **9.9s** | 3 | $0.008 |
| city-weather | Claude Code (flash) | **12/12** | 3/3 | 50.4s | 50.0s | 64.5s | 6 | $0.130 |
| nasdaq-drops | NanoAgent | **12/12** | 3/3 | **42.6s** | **43.6s** | **49.3s** | 3 | $0.022 |
| nasdaq-drops | Claude Code (flash) | 3/12 | 3/3 | 381.4s | 354.7s | 632.7s | 21 | $0.543 |

时间花在哪里（中位数，按各系统自己的时钟统计）：

| | 参考答案 | 模型 | 工具及其他 |
|---|---|---|---|
| nasdaq NanoAgent | 30.9s | 12.2s | 30.4s |
| nasdaq Claude Code (flash) | — | 103.3s | 220.0s |
| weather NanoAgent | 1.4s | 6.5s | 1.3s |
| weather Claude Code (flash) | — | 26.7s | 23.5s |

- **天气：** 同一个模型，Claude Code 比 NanoAgent 慢 6.3 倍；之前用 Opus 时慢 2.6 倍。两边都全部答对。
- **股票：** Claude Code 慢 8.1 倍，单次从 9s 到 831s 不等。真正动手做的 11 次里，有 10 次是逐只串行下载 100 只股票。有 9 条命令撞上了 Claude Code 单条 Bash 命令 120s 的上限，被转到后台运行，之后它用 `sleep` 循环去等结果，一共写了 17 个这样的循环。用 Opus 时，36 次里有 32 次是并行下载。
- **股票题错的 9 次，原因如下：**

| 原因 | 题目 |
|---|---|
| 窗口起点晚了一个交易日。提示里写明了窗口“starts on the trading day N sessions before as_of” | 01、05、07、11 |
| 股票和数字都对，但把 Nasdaq 公司名末尾的空格去掉了 | 04、09、10 |
| 没有按跌幅从大到小排序 | 08 |
| 唯一的一轮输出了无关的文字，没调用工具，也没交答案 | 12 |

  verifier 要求公司名和 Nasdaq 列出的一字不差，所以 04、09、10 按规则算错。如果宽松一点、不计较名字末尾的空格，就是 6/12。
- **拒绝：** 两边都拒绝对了。NanoAgent 由参考工具拒绝，用时 0.4–7.1s；Claude Code 由模型自己判断，用时 6.1–26.5s。
- **`/tmp`：** flash 会写 `/tmp/aapl.json`、`/tmp/ndx.json` 这类固定文件名，前面的运行也用过同样的名字。我逐个看了对话记录：每一次，后面的运行都是先重新下载或重新写这个文件，然后才读，所以没有哪一次用到了别的运行留下的数据。
- **运行情况：** 原计划跑 3 轮，因为太慢减成了 1 轮。nasdaq-drops-09 的 Claude Code 那次运行中途，Mac 在电池供电下合盖睡了 10 分钟。这次结果作废，等这一轮跑完后重跑了一次，所以它没有按原本的顺序跑。

## 局限

- **主实验里两边模型不同：** 主实验对比的是两个系统各自开箱即用的样子，不是在同一模型下比较框架。成本差距和天气任务的速度差距，有很大一部分来自模型。上面的同模型对比把框架的影响单独拿了出来，但只跑了 1 轮。
- **Claude Code 的 `/tmp` 是共享的：** 不同运行用了同名目录（`/tmp/ndx`、`/tmp/ndq` 等）。我检查了 Claude Code 全部 45 次股票任务的转录记录：每次作答的运行都自己重新下载了历史数据，脚本里也没有 “文件已存在就跳过” 这类缓存逻辑，**没有发现它复用其他运行的数据**。但目录同名是一个隐患，下次应该给每次运行单独的临时目录（比如设置 `TMPDIR`）。
- **第 3 轮是分两次跑完的：** 前 132 次在 05:42 到 07:10（UTC）跑完，剩下 48 次在约 10 小时后的 17:08 到 17:23（UTC）续跑。续跑前后两个系统依旧轮流运行，各轮的中位数也一致。
- **题目覆盖有限：** 只有 2 个插件、30 道题，都是 “拉数据再筛选” 一类的任务；纳斯达克 100 的成分股取的是当前名单。
- **给 Claude Code 的提示里写明了数据源和 API。** 如果不告诉它数据源，它会更慢，也更容易出错。

## 可以改进的地方

1. **让参考答案和 agent 并行计算**（改 `nanoagent/src/nanoagent/plugin/tasks.py` 里的 `_run`）。股票任务的总时间预计从 73s 降到约 42s，就能快过 Claude Code。
2. **把插件下载的并发数从 8 提到 32**（`nasdaq-drops/src/plugin/changes.py` 里的 `WORKERS`）。实测下载时间从 27s 降到 10.5s，参考答案和 agent 两边都受益。
3. **让工具直接按条件筛好结果再返回**，比如给 agent 用的工具加上 `min_drop_percent` 参数，模型就不用自己抄长列表了。这样既能消除 nasdaq-12 那种漏项，模型时间也会更短。
4. **在拒绝路径下也保存对话记录**，方便排查 city-weather-06 这类问题。

## 复现

从仓库根目录运行。NanoAgent 需要设置 `OPENROUTER_API_KEY`，Claude Code 使用本机已登录的账号。

```bash
bash nanoagent/examples/agent_timing/runs/step1_build_cases.sh
bash nanoagent/examples/agent_timing/runs/step2_run_agents.sh out-of-box   # 中断后再运行一次会续跑
bash nanoagent/examples/agent_timing/runs/step3_score.sh out-of-box
bash nanoagent/examples/agent_timing/runs/step2_run_agents.sh same-model repeats=1
bash nanoagent/examples/agent_timing/runs/step3_score.sh same-model
```

每次运行的明细在 `outputs/step2_run_agents/out-of-box/runs/<case>/<system>-<repeat>/`：
- `attempt.json`：本次运行的记录。
- NanoAgent 的 `messages.json`：ATIF 格式的对话记录。
- Claude Code 的 `reply.txt` 和 `workspace/`。

打分结果在 `outputs/step3_score/out-of-box/scores.json`。
