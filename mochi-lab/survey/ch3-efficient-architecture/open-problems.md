---
sidebar_position: 13
title: "Open Problems & Future Directions"
---

## Open Problems & Future Directions

### Scaling Laws for Efficiency

While we have scaling laws for dense Transformers [@kaplan2020scaling, @hoffmann2022training], equivalent laws for MoE models, SSMs, and hybrid architectures are nascent. Understanding how efficiency gains scale with model size, data, and compute is critical for making informed architectural decisions at the frontier.

### Dynamic Compute Allocation

Current architectures allocate fixed compute per token (or per expert in MoE), but some tokens are "harder" than others. Adaptive computation -- allocating more compute to difficult inputs and less to easy ones -- could dramatically improve average efficiency. Early exits [@schuster2022confident], mixture-of-depths [@raposo2024mixture], and conditional computation are promising but underexplored at scale.

### Co-Design of Algorithms and Hardware

The gap between theoretical algorithmic efficiency and practical hardware efficiency remains large. Architectures designed in tandem with hardware -- exploiting specific memory hierarchies, data movement patterns, and compute primitives -- can achieve speedups that purely algorithmic approaches cannot. FlashAttention exemplifies this principle, but systematic co-design methodologies are lacking.

### Unifying Efficient Architectures

The proliferation of efficient architectures (SSMs, linear attention, convolutions, RNNs, hybrids) raises the question: is there a unified framework that encompasses these approaches? Recent work connecting SSMs to attention [@dao2024transformers] and linear attention to recurrence [@peng2023rwkv] suggests convergence, but a comprehensive theoretical framework is missing.

### Efficiency for Multimodal Models

As AI models increasingly process multiple modalities (text, images, video, audio), efficiency challenges multiply. Processing a single video frame as tokens can consume the entire context window of current models. Efficient multimodal architectures that can handle heterogeneous input types without quadratic cost in total token count are urgently needed.
