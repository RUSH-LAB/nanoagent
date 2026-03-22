---
sidebar_position: 10
title: "State Space Models"
---

## State Space Models

State Space Models (SSMs) offer a fundamentally different approach to sequence modeling, achieving linear complexity in sequence length while maintaining the ability to capture long-range dependencies.

### S4

Gu et al. (2022) [@gu2022efficiently] introduced S4 (Structured State Spaces for Sequence Modeling), which parameterizes a continuous-time state space system and discretizes it for sequence processing. S4's key innovation is the HiPPO initialization, which provably enables long-range memory. S4 achieved breakthrough performance on the Long Range Arena benchmark, dramatically outperforming Transformers on tasks requiring very long-range dependencies (16k+ tokens).

### Mamba

Gu and Dao (2024) [@gu2024mamba] introduced Mamba, which makes SSM parameters input-dependent (selective), enabling content-based reasoning that fixed-parameter SSMs cannot perform. Mamba achieves linear-time sequence processing with a hardware-aware scan algorithm that avoids materializing the full state matrix. Mamba matches Transformer quality on language modeling while being 5x faster at inference for long sequences. Mamba-2 [@dao2024transformers] further unified SSMs with structured attention, showing that selective state spaces and attention are mathematically related.

### Jamba

Lieber et al. (2024) [@lieber2024jamba] introduced Jamba (AI21 Labs), a hybrid architecture that interleaves Mamba layers with Transformer attention layers and MoE modules. Jamba demonstrated that hybrid architectures combining SSM efficiency with attention's in-context learning ability can outperform pure Transformers and pure SSMs. With a 52B total parameter MoE model (12B active), Jamba delivered high quality with excellent efficiency.

### Griffin

De et al. (2024) [@de2024griffin] (Google DeepMind) proposed Griffin, which combines gated linear recurrences (a simplified SSM variant) with local attention. Griffin demonstrated that even simple recurrent mechanisms, when combined with selective local attention, can match Transformer quality at large scale while being much more efficient for long-context inference.
