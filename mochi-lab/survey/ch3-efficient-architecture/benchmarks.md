---
sidebar_position: 12
title: "Benchmarks & Evaluation"
---

## Benchmarks & Evaluation

### Standard Benchmarks

- **MLPerf** [@mattson2020mlperf]: Industry-standard benchmarks for training and inference performance across hardware and software stacks. MLPerf measures wall-clock time to train to a target quality or inference throughput at target latency.
- **HELM** (Liang et al., 2023) [@liang2023holistic]: The Holistic Evaluation of Language Models includes efficiency metrics alongside accuracy, evaluating models on a broad set of tasks with controlled compute budgets.
- **LMSys Chatbot Arena**: While primarily a quality benchmark, the serving infrastructure behind Chatbot Arena (using vLLM) has driven practical innovations in inference efficiency.
- **Long Range Arena** (Tay et al., 2021) [@tay2021long]: Specifically designed to evaluate efficient sequence models on tasks requiring long-range dependencies (up to 16k tokens).

### Evaluation Challenges

Efficiency evaluation is complicated by hardware dependence (an architecture efficient on one GPU may not be on another), the distinction between theoretical complexity and practical speed (constant factors matter enormously), and the tradeoff between throughput and latency (high-throughput batched inference vs. low-latency single-query inference).
