---
slug: browsecomp
title: "Solving BrowseComp: Three Paths to Building Better Search Agents"
authors: [zeyu]
tags: [llm, agents, search, browsecomp]
---

BrowseComp is one of the hardest benchmarks for LLM-based search agents. It requires deep, multi-hop web research where the agent must plan, search, read, and synthesize across dozens of interactions. Three recent papers attack this problem from fundamentally different angles: context management, data quality, and verification. Together they paint a clear picture of what it takes to build a frontier search agent today.

<!-- truncate -->

## The Problem

Standard ReAct agents accumulate a growing log of thought-action-observation triplets. On short tasks this works fine. On BrowseComp, where a single question can require 50+ tool calls, the context becomes saturated with noisy web content, burying the critical signals the agent needs to reason effectively. The three papers below each identify a different bottleneck and propose a different solution.

## AgentFold: Teach the Agent to Forget Strategically

**Paper:** [AgentFold (Ye et al., 2025)](https://arxiv.org/abs/2510.24699)

AgentFold frames the problem as a *context engineering* challenge. Instead of treating the context window as a passive log to be filled, AgentFold treats it as a dynamic cognitive workspace to be actively sculpted.

At each step, the agent produces two outputs simultaneously: a tool call and a **folding directive**. The folding directive compresses the historical trajectory at multiple granularities:

- **Granular condensation**: distill a single interaction into a compact summary while preserving key details
- **Deep consolidation**: abstract away an entire multi-step sub-task into a high-level state record

The context is explicitly partitioned into **Multi-Scale State Summaries** (long-term memory) and the **Latest Interaction** (working memory). This keeps the context focused: after 100 turns of interaction, the working context is only ~7k tokens, and the agent can scale to 500 turns without degradation.

Training data is generated via **Fold-Generator**, a pipeline that produces trajectories annotated with folding decisions through rejection sampling.

| | |
|---|---|
| **Core insight** | The agent should learn *what to remember and what to compress*, not just what action to take |
| **Training** | SFT only (Qwen3-30B-A3B) |
| **BrowseComp** | 36.2% (EN), 47.3% (ZH) |

## OpenSeeker-v2: Better Data Beats Better Algorithms

**Paper:** [OpenSeeker-v2 (Du et al., 2026)](https://arxiv.org/abs/2605.04036)

OpenSeeker-v2 challenges the assumption that training search agents requires a heavy multi-stage pipeline (CPT → SFT → RL). Its central claim: **with sufficiently high-quality, high-difficulty data, plain SFT is enough.**

Three modifications to the data synthesis pipeline make the difference:

1. **Scaling knowledge graph size.** The topological subgraph used for question generation is expanded significantly. Larger subgraphs contain more diverse reasoning paths, producing questions that structurally require deep multi-hop exploration.

2. **Expanding the tool set.** More tools means more diverse interaction patterns. The agent learns versatile strategies instead of over-relying on a single search tool.

3. **Strict low-step filtering.** Any trajectory solvable in fewer than $T_{\min}$ tool calls is discarded. This enforces a minimum difficulty floor, ensuring every training example requires sustained reasoning.

The result: only **10.6k trajectories**, a single SFT run, no RL. Yet it beats models trained with full CPT+SFT+RL pipelines.

| | |
|---|---|
| **Core insight** | Data difficulty and diversity matter more than training complexity |
| **Training** | SFT only (Qwen3-30B-A3B) |
| **BrowseComp** | 46.0% (EN), 58.1% (ZH) |

## MiroThinker-H1: Train Harder, Then Verify Everything

**Paper:** [MiroThinker-1.7 & H1 (MiroMind, 2026)](https://arxiv.org/abs/2603.15726)

MiroThinker takes the opposite stance from OpenSeeker-v2: it invests heavily in both training and inference. The system has two layers.

**MiroThinker-1.7** is the base agent, trained through a four-stage pipeline:

1. **Agentic mid-training**: strengthen atomic capabilities (planning, reasoning, tool use, summarization) with a planner-judge filtering pipeline
2. **SFT**: learn structured multi-step interaction from expert trajectories
3. **DPO**: preference optimization using answer correctness as the sole ranking signal (no structural constraints)
4. **GRPO RL**: online reinforcement learning with entropy control to prevent policy collapse

Context management uses a sliding window ($K=5$): only the five most recent observations are kept in full, while the complete thought-action trace is preserved. If the agent exhausts its turn budget, it restarts from scratch (episode loop).

Data synthesis is also more elaborate, with two complementary pipelines:
- **Corpus-based pipeline**: high-volume QA from knowledge graph subgraphs
- **WebHop pipeline**: structured reasoning trees with web expansion, hierarchical solvability verification, and adaptive leaf obfuscation to prevent shortcut solutions

**MiroThinker-H1** adds verification on top:

- **Local Verifier**: at each step, prompts the agent to explore paths it would not naturally choose, countering the model's probability bias toward habitual thinking
- **Global Verifier**: audits the complete evidence chain before the agent commits to a final answer. If evidence is insufficient, the agent is asked to continue rather than deliver a premature response

| | |
|---|---|
| **Core insight** | Make each step more reliable (mid-training), then add verification at both local and global levels |
| **Training** | Mid-training + SFT + DPO + RL |
| **BrowseComp** | SOTA at time of publication |

## Comparison

The three papers are complementary rather than competing. They target different bottlenecks in the search agent stack:

| Dimension | AgentFold | OpenSeeker-v2 | MiroThinker-H1 |
|---|---|---|---|
| **Core question** | How to manage context? | What data to train on? | How to train and verify? |
| **Approach** | Learned context folding | High-difficulty data synthesis | 4-stage training + dual verification |
| **Training cost** | Low (SFT only) | Low (SFT only) | High (mid-train + SFT + DPO + RL) |
| **Inference cost** | Low (compact context) | Standard | High (verification overhead) |
| **Key innovation** | Multi-scale folding directives | Minimum-difficulty filtering | Local + global verifiers |

OpenSeeker-v2 explicitly positions itself as orthogonal to the other two, noting that its focus is data quality within the standard ReAct paradigm, while AgentFold and MiroThinker innovate on context management and training methodology respectively.

## Takeaways

1. **Context is the bottleneck for long-horizon agents.** Both AgentFold and MiroThinker address this, just differently: AgentFold learns to fold, MiroThinker uses a sliding window with episode restarts.

2. **Data quality can substitute for training complexity.** OpenSeeker-v2 shows that 10k well-curated examples with SFT alone can match or beat heavily-engineered pipelines. The minimum difficulty floor is the most underappreciated trick.

3. **Verification is cheap relative to generation.** MiroThinker-H1 exploits the generation-verification asymmetry: checking whether evidence supports an answer is easier than finding that evidence in the first place.

4. **These approaches compose.** Nothing stops you from using high-quality data (OpenSeeker) with context folding (AgentFold) and verification (MiroThinker). The next SOTA will likely combine all three.
