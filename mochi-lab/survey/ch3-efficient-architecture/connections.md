---
sidebar_position: 14
title: "Connections to Other Chapters"
---

## Connections to Other Chapters

**Continual Learning (Chapter 1):** MoE architectures naturally support continual learning by adding new experts for new tasks. Parameter-efficient fine-tuning methods (LoRA, adapters) reduce the cost of adaptation while potentially mitigating forgetting. Efficient architectures enable more frequent model updates, making continual learning more practical.

**World Models (Chapter 2):** World models benefit directly from efficient architectures: SSMs can model long-horizon dynamics with linear cost; efficient attention enables video-based world models with longer temporal context; and MoE can scale world models across diverse domains without proportional compute.

**Agentic Search (Chapter 4):** Efficient inference is critical for agentic systems that perform many model queries during search and planning. Speculative decoding and KV-cache optimization directly impact the cost of tree search and iterative retrieval strategies.

**Randomized Algorithms (Chapter 5):** Many efficient architecture techniques have roots in randomized algorithms: random feature approximations for attention kernels, hashing-based sparse attention (SLIDE), sketching for gradient compression, and random projections for dimensionality reduction in SSMs.
