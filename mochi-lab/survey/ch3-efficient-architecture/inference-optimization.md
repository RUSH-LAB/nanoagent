---
sidebar_position: 9
title: "Inference Optimization"
---

## Inference Optimization

### Speculative Decoding

Leviathan et al. (2023) [@leviathan2023fast] and Chen et al. (2023) [@chen2023accelerating] independently proposed speculative decoding, where a small "draft" model generates candidate tokens that are then verified in parallel by the large target model. Since verification of k tokens costs the same as generating 1 token (a single forward pass), speculative decoding can achieve 2-3x speedups when the draft model's acceptance rate is high, without any change in output distribution.

### KV-Cache Optimization

The key-value cache grows linearly with sequence length during autoregressive generation, becoming a major memory bottleneck for long sequences. Several approaches address this:

- **Multi-Query/Grouped-Query Attention** [@shazeer2019fast, @ainslie2023gqa] reduces cache size at the architecture level.
- **PagedAttention** (Kwon et al., 2023) [@kwon2023efficient] manages KV-cache memory using virtual memory concepts, eliminating fragmentation and enabling near-optimal memory utilization. vLLM, built on PagedAttention, has become the standard serving framework.
- **KV-cache compression** methods like H2O (Zhang et al., 2024) [@zhang2024h2o] dynamically evict less important cache entries, maintaining quality while bounding memory usage.
- **SpeCache** (2025) [@specache2025speculative] applies speculative execution concepts to KV-cache management, prefetching and managing cache entries based on predicted future attention patterns.

### Continuous Batching and Serving

Efficient serving requires maximizing GPU utilization across multiple concurrent requests. Continuous batching (Yu et al., 2022) [@yu2022orca] dynamically adds and removes requests from a running batch as they arrive and complete, avoiding the throughput waste of static batching. This is implemented in systems like vLLM [@kwon2023efficient], TensorRT-LLM, and SGLang.
