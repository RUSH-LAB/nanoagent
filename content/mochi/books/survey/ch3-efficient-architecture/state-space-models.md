---
sidebar_position: 10
title: "State Space Models"
---

## State Space Models

State Space Models (SSMs) offer a fundamentally different approach to sequence modeling, achieving linear complexity in sequence length while maintaining the ability to capture long-range dependencies. SSMs have their mathematical roots in control theory and signal processing, modeling sequences through continuous-time dynamical systems that are discretized for practical computation.

### S4: Structured State Spaces

Gu et al. (2022) [@gu2022efficiently] introduced S4 (Structured State Spaces for Sequence Modeling), which parameterizes a continuous-time linear state space system:

x'(t) = Ax(t) + Bu(t), y(t) = Cx(t) + Du(t)

and discretizes it for sequence processing. S4's key innovations include:

1. **HiPPO initialization:** The state matrix A is initialized using the HiPPO (High-Order Polynomial Projection Operator) theory [@gu2020hippo], which provably enables optimal memorization of continuous signals through polynomial projection. Different HiPPO variants correspond to different memory profiles (e.g., sliding window, exponential decay, uniform memory).

2. **Structured parameterization:** A is decomposed into a specific low-rank plus diagonal form that enables efficient computation via the Cauchy kernel, reducing the computational cost from O(N^2) to O(N log N) in sequence length.

S4 achieved breakthrough performance on the Long Range Arena benchmark, dramatically outperforming Transformers on tasks requiring very long-range dependencies (16k+ tokens). On the PathX task (classifying images represented as length-16k pixel sequences), Transformers achieved random chance while S4 was the first model to solve the task at all, and on Path-X S4 reached a reported accuracy of 88.1%, demonstrating that SSMs can capture dependencies at scales where attention simply fails.

**S4D** [@gu2022parameterization] simplified S4 by restricting the state matrix to be diagonal, greatly simplifying the implementation while maintaining most of S4's performance. This simplification was key to making SSMs practical and broadly adoptable.

### Mamba: Selective State Spaces

Gu and Dao (2024) [@gu2024mamba] introduced Mamba, which addressed a fundamental limitation of previous SSMs: their parameters are fixed (not input-dependent), meaning they process all tokens identically. This prevents SSMs from performing content-based reasoning, that is, selecting which information to remember or forget based on the content of the input.

Mamba makes SSM parameters **input-dependent** (selective): the B, C, and delta (discretization step) matrices are functions of the input, computed by small linear projections. This selectivity mechanism enables Mamba to dynamically decide what information to store in its state based on the current input, analogous to how attention selectively focuses on relevant tokens. The key engineering contribution is a **hardware-aware parallel scan algorithm** that computes the selective SSM efficiently on GPUs, avoiding the materialization of the full state matrix.

Mamba matches Transformer quality on language modeling (perplexity) while reporting roughly 5x higher inference throughput on long sequences. The gain is specific to the autoregressive decode regime: because Mamba carries a fixed-size recurrent state, it generates each token in O(1) time and memory after a linear-time forward pass, whereas a Transformer must attend over a growing KV cache, giving it O(n) per-token cost as the sequence lengthens. The 5x figure is therefore a decode-time throughput improvement, not a training speedup. On the key benchmark of language modeling perplexity as a function of compute, Mamba's scaling curve tracks the Transformer's, suggesting that SSMs are a viable alternative for foundation model pre-training.

**Mamba-2** [@dao2024transformers] further unified SSMs with structured attention, showing that selective state spaces and structured masked attention are **mathematically equivalent** under certain conditions. This theoretical connection, called SSD (State Space Duality), means that insights and optimizations from one framework can be transferred to the other, and suggests that SSMs and attention are not fundamentally different paradigms but rather different views of the same underlying computation.

### Hybrid Architectures

The emerging consensus is that the best architectures combine SSM efficiency with attention expressiveness, leveraging the strengths of both.

**Jamba** (Lieber et al., 2024) [@lieber2024jamba] (AI21 Labs) is a production-grade hybrid that interleaves Mamba layers with Transformer attention layers and MoE modules. The architecture uses a ratio of roughly 7:1 Mamba-to-attention layers, using attention sparingly where in-context learning is most needed. With a 52B total parameter MoE model (12B active), Jamba matched comparably sized Transformer baselines on standard language benchmarks while fitting a 256K-token context window on a single 80GB GPU, which would require multiple GPUs for a pure Transformer of similar quality.

**Griffin** (De et al., 2024) [@de2024griffin] (Google DeepMind) combines gated linear recurrences (a simplified SSM variant called HAWK) with local sliding-window attention (GRIFFIN). Griffin demonstrated that even simple recurrent mechanisms, when combined with selective local attention, can match Transformer quality at large scale while being much more efficient for long-context inference. The comparison between HAWK (pure recurrence) and GRIFFIN (recurrence + local attention) showed that local attention provides a consistent quality boost, particularly for tasks requiring precise token-to-token matching.

**Zamba** and **Zamba-2** (Glorioso et al., 2024) [@glorioso2024zamba] further explored the hybrid design space, finding that a single shared attention layer interleaved among many Mamba layers (rather than unique attention layers) achieves strong performance with minimal parameter overhead.

### The SSM vs. Attention Debate

The relationship between SSMs and attention remains an active area of research. Key questions include: (1) What capabilities do attention layers provide that SSMs cannot replicate? (The current evidence suggests in-context learning and precise copying/retrieval are harder for SSMs.) (2) What is the optimal ratio of SSM to attention layers in hybrid architectures? (3) Will SSMs eventually replace attention entirely, or will hybrids remain dominant? The theoretical unification in Mamba-2 suggests that the dichotomy may be false: both are instances of a more general framework.
