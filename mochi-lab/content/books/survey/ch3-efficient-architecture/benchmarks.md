---
sidebar_position: 12
title: "Benchmarks & Evaluation"
---

## Benchmarks & Evaluation

### Standard Benchmarks

Evaluating efficient architectures requires benchmarks that measure both quality and efficiency, ideally on realistic tasks at meaningful scale.

**MLPerf** [@mattson2020mlperf] provides the industry-standard benchmarks for training and inference performance, measuring wall-clock time to train to a target quality or inference throughput at target latency across different hardware and software stacks. MLPerf's strength is its emphasis on reproducibility and fair comparison across systems, though the benchmark tasks (image classification, object detection, language modeling, recommendation, speech recognition, and reinforcement learning) may not capture the full diversity of practical workloads. MLPerf has driven significant systems-level optimizations, with successive submissions on the same benchmarks reflecting a combination of hardware improvements, software optimization (cuDNN kernels, compiler improvements), and algorithmic innovations (FlashAttention, fused operators).

**HELM (Holistic Evaluation of Language Models)** (Liang et al., 2023) [@liang2023holistic] evaluates language models across a broad set of tasks (42 scenarios covering knowledge, reasoning, summarization, etc.) with controlled compute budgets, providing the most comprehensive quality benchmark for LLMs. While HELM primarily measures quality rather than efficiency, the combination of HELM scores with efficiency metrics enables meaningful comparisons of quality-per-FLOP across architectures.

**Long Range Arena (LRA)** (Tay et al., 2021) [@tay2021long] was specifically designed to evaluate efficient sequence models on tasks requiring long-range dependencies. LRA includes six tasks with sequence lengths up to 16K tokens (ListOps, text classification, document retrieval, image classification from pixel sequences, pathfinder, and PathX). State space models marked a breakthrough on LRA: S4 [@gu2022efficiently] was the first architecture to set state of the art across all six tasks, and notably the first to solve PathX (length 16K), a binary classification task on which prior Transformer variants had remained at roughly random chance (around 50% accuracy). This pushed the LRA average well above the level reached by earlier efficient-attention models. However, LRA has been criticized for not correlating well with performance on practical tasks like language modeling.

**RULER** (Hsieh et al., 2024) [@hsieh2024ruler] provides a synthetic benchmark for evaluating long-context capabilities, testing retrieval, multi-hop reasoning, and aggregation over configurable context lengths. RULER enables controlled evaluation of how well different architectures maintain quality as context length increases, a critical metric for efficient long-context architectures.

**LMSys Chatbot Arena** [@zheng2023judging] provides real-world quality evaluation through human preference ratings, and the serving infrastructure behind it (using vLLM) has driven practical innovations in inference efficiency. While not a formal efficiency benchmark, the economic pressure of serving millions of arena conversations has motivated significant optimization work.

**MTEB (Massive Text Embedding Benchmark)** [@muennighoff2023mteb] evaluates embedding models across diverse tasks and is relevant for evaluating efficient architectures for retrieval and embedding applications, where inference throughput (embeddings per second) is a key metric.

### Evaluation Challenges

Efficiency evaluation is complicated by several factors:

**Hardware dependence:** An architecture efficient on one GPU may not be on another. Sparse attention patterns that are efficient on GPUs with hardware sparse matrix support may be slower than dense attention on GPUs without it. MoE models that excel on multi-GPU systems with high-bandwidth interconnects may be impractical on single GPUs. Any efficiency claim must be qualified by the target hardware.

**Theoretical vs. practical complexity:** Two algorithms with the same asymptotic complexity can differ by orders of magnitude in practice. FlashAttention [@dao2022flashattention] has the same O(n^2) theoretical complexity as standard attention but reports roughly 2-4x wall-clock speedups due to its IO-aware design. Constant factors, memory access patterns, and hardware utilization dominate at practical scales.

**Throughput vs. latency:** High-throughput batched inference (maximizing tokens/second across all requests) and low-latency single-query inference (minimizing time-to-first-token for a single request) often require different optimizations. Speculative decoding improves latency but not throughput; larger batch sizes improve throughput but increase latency. Benchmarks should specify which metric they optimize.

**Apples-to-apples comparison:** Comparing architectures requires controlling for confounding factors: model size, training data, training compute, implementation quality, and hardware. A model that appears more efficient may simply be better implemented. The most reliable comparisons train multiple architectures from scratch on the same data with the same compute budget, but this is expensive and rarely done comprehensively.

**Quality-efficiency Pareto frontier:** No single number captures efficiency. The meaningful comparison is between quality-efficiency Pareto frontiers (the set of architectures that are not dominated by any other architecture in the quality-efficiency space). A model is truly more efficient only if it shifts the Pareto frontier. The Chinchilla scaling law [@hoffmann2022training] established one such frontier: for a fixed compute budget, the optimal model size and training data size are roughly equal (in tokens). Architectures that achieve the same quality with less total compute are genuinely more efficient.

### Practical Efficiency Metrics

Beyond benchmark scores, several practical metrics drive efficiency research in production settings:

- **Time-to-first-token (TTFT):** The latency from request submission to the first generated token. Critical for interactive applications (chatbots, code completion). TTFT is dominated by prompt processing time, making efficient prefill computation (FlashAttention, prompt caching) essential for long-context applications.
- **Tokens per second per GPU:** The throughput metric for serving systems. As an order-of-magnitude estimate, a single H100 GPU can serve on the order of thousands of tokens/second for a 7B parameter model, with the exact figure depending heavily on precision, batch size, and sequence length. For larger models requiring multi-GPU inference, the tokens/second/dollar metric becomes more relevant.
- **Memory per token:** The KV-cache memory consumption determines the maximum batch size and context length. Standard attention requires O(n * d) memory per layer, where n is the sequence length and d is the head dimension. Techniques like multi-query attention [@shazeer2019fast], grouped-query attention [@ainslie2023gqa], and KV-cache compression can reduce this by 4-8x.
- **Cost per query:** The aggregate metric combining throughput, hardware cost, and utilization. For ChatGPT-scale services processing billions of queries per month, reducing cost-per-query by even 10% represents millions of dollars in savings annually.

These practical metrics often diverge from theoretical complexity measures: an algorithm with better asymptotic complexity may have worse practical performance due to constant factors, memory access patterns, or poor hardware utilization. This gap between theory and practice makes empirical benchmarking essential for efficiency claims.
