---
sidebar_position: 2
title: "Problem Formulation"
---

## Problem Formulation

### The Efficiency-Performance Tradeoff

The central problem in efficient architecture design is optimizing the Pareto frontier of computational cost versus task performance [@thompson2020computational]. Given a computational budget B (measured in FLOPs, memory, latency, or energy), the goal is to find architecture A* and parameters theta* that maximize performance:

A*, theta* = argmax_{A, theta} Performance(A, theta) subject to Cost(A, theta) <= B

This formulation applies at multiple levels: architecture design (macro choices like layer types and connectivity patterns), training (how to use the compute budget most effectively to learn good parameters), and inference (how to serve predictions cheaply while maintaining quality). Each level involves fundamentally different tradeoffs and optimization landscapes.

### Scaling Laws as a Framework

Kaplan et al. (2020) [@kaplan2020scaling] established the foundational neural scaling laws, showing that language model cross-entropy loss follows a power law in model size N, dataset size D, and compute budget C:

L(N) ~ N^{-alpha_N}, L(D) ~ D^{-alpha_D}, L(C) ~ C^{-alpha_C}

with exponents alpha_N ~ 0.076, alpha_D ~ 0.095, alpha_C ~ 0.050 for decoder-only Transformers. These laws revealed that performance improvement follows diminishing returns: each 10x increase in compute yields a fixed reduction in loss, not a proportional one.

Hoffmann et al. (2022) [@hoffmann2022training] refined these laws with the Chinchilla analysis, demonstrating that many existing models were over-parameterized relative to their training data. The Chinchilla-optimal allocation roughly matches model parameters and training tokens (in count), leading to the prescription: for a given compute budget C, train a model of size N ~ C^{0.5} on D ~ C^{0.5} tokens. This shifted the field toward training smaller models on more data -- Chinchilla (70B) outperformed the much larger Gopher (280B) by training on 4x more tokens.

Efficient architecture design can be understood as **changing the constants** in these scaling laws. An architecture that achieves the same loss at lower compute does not change the exponents but shifts the entire scaling curve downward. From this perspective, every efficiency technique -- from FlashAttention to MoE to quantization -- can be evaluated by how much it shifts the scaling curve, providing a unified framework for comparing fundamentally different approaches.

### Beyond Scaling Laws: The Efficiency Taxonomy

The scaling law framework, while powerful, misses important dimensions of efficiency. A complete picture requires considering:

**Compute efficiency** -- the total number of floating-point operations required. This is the most common measure but can be misleading: two algorithms with the same FLOP count can have very different wall-clock times due to memory access patterns, parallelizability, and hardware utilization.

**Memory efficiency** -- the peak memory required during training or inference. Memory is often the binding constraint in practice: a model that fits in GPU memory can be trained/served on a single device, while a model that exceeds memory requires multi-device deployment with communication overhead. The KV-cache in autoregressive generation grows linearly with sequence length, making memory a particularly acute bottleneck for long-context applications.

**Latency efficiency** -- the time to produce a single output (e.g., time-to-first-token, or per-token generation latency). Latency matters for interactive applications where users expect real-time responses. Latency optimization often involves different techniques than throughput optimization -- speculative decoding improves latency but not throughput, while batching improves throughput but not latency.

**Throughput efficiency** -- the number of outputs produced per unit time across a batch of inputs. Throughput matters for high-volume serving scenarios. The distinction between latency and throughput reflects the difference between the user experience (latency) and the provider's economics (throughput).

**Parameter efficiency** -- achieving a given performance level with fewer learnable parameters. Parameter efficiency reduces storage costs, enables easier deployment (smaller model files), and is connected to generalization through implicit regularization. Parameter-efficient fine-tuning (PEFT) methods like LoRA achieve parameter efficiency by learning low-rank updates to a frozen base model.

**Energy efficiency** -- the total energy consumed for training or inference. Energy efficiency is increasingly important for environmental sustainability and operating cost. Energy is roughly proportional to FLOPs multiplied by hardware power consumption, but can be reduced through more efficient hardware utilization, reduced precision, or sparsity.

### Efficiency Metrics

Key metrics for evaluating efficiency include:
- **FLOPs per token** (training and inference): The fundamental compute cost measure
- **Wall-clock time** (accounting for hardware utilization): Captures real-world efficiency including memory access and communication overhead
- **Memory footprint** (peak memory, KV-cache size): Determines hardware requirements and maximum batch size/sequence length
- **Throughput** (tokens/second at given batch size): Measures serving capacity
- **Latency** (time-to-first-token, per-token generation time): Measures user experience quality
- **Energy consumption** (kWh per training run or per inference query): Measures environmental and economic cost
- **Model quality per FLOP** (accuracy/perplexity as a function of compute): The ultimate efficiency metric, captured by scaling curves
- **Hardware utilization** (MFU -- Model FLOPs Utilization): The fraction of theoretical peak compute actually achieved, reflecting implementation quality

The proliferation of metrics reflects a fundamental truth: efficiency is multi-dimensional, and no single number captures it. A technique that improves FLOP count may worsen memory usage; one that improves throughput may worsen latency. Practical efficiency optimization requires considering the specific deployment constraints and optimizing the relevant metrics.
