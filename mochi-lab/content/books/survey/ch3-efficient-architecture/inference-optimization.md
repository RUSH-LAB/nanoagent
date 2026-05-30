---
sidebar_position: 9
title: "Inference Optimization"
---

## Inference Optimization

For widely deployed models, aggregate inference cost can dwarf training cost within months of deployment. A model serving millions of users generates billions of inference requests, each requiring a forward pass through billions of parameters. This section surveys techniques that reduce the latency, throughput cost, and memory requirements of inference.

### Speculative Decoding

**Speculative decoding** was independently proposed by Leviathan et al. (2023) [@leviathan2023fast] and Chen et al. (2023) [@chen2023accelerating]. The core idea exploits the asymmetry between generation and verification in autoregressive models: generating k tokens requires k sequential forward passes of the large model, but **verifying** k tokens requires only a single forward pass (since all positions can be processed in parallel).

Speculative decoding uses a small, fast "draft" model to generate k candidate tokens, then passes the entire candidate sequence through the large "target" model for parallel verification. Tokens are accepted from left to right as long as they match the target model's distribution (using a rejection sampling scheme that guarantees the final output distribution is **identical** to the target model's distribution, regardless of the draft model's quality). When a token is rejected, generation reverts to the target model from that point.

The speedup depends on the draft model's **acceptance rate** alpha: if each token is accepted with probability alpha, the expected number of tokens generated per target model call is 1/(1-alpha). For well-matched draft-target pairs, acceptance rates of 60-80% yield 2-3x speedups with zero change in output quality. Speculative decoding is widely deployed in production serving stacks.

**Self-speculative decoding** variants avoid the need for a separate draft model by using the target model itself in a reduced mode (e.g., skipping layers, using a subset of attention heads) as the draft model, simplifying deployment at the cost of somewhat lower acceptance rates.

**Medusa** (Cai et al., 2024) [@cai2024medusa] takes a different approach: instead of a separate draft model, Medusa adds multiple "heads" to the target model that predict future tokens in parallel. During inference, all heads generate candidate tokens simultaneously, and tree-structured verification checks all candidate sequences in a single forward pass. Medusa achieves 2-3x speedups with minimal additional parameters.

### KV-Cache Optimization

During autoregressive generation, previously computed key and value vectors are cached to avoid recomputation. This **KV-cache** grows linearly with sequence length, consuming O(n * L * h * d) memory (where n is the sequence length, L is the number of layers, h is the number of heads, and d is the head dimension). For a 70B parameter model with 128K context, the KV-cache alone can require 100+ GB of memory, often exceeding the memory used by the model parameters themselves.

**Architectural solutions** (covered in the Efficient Attention section) reduce the KV-cache at the architecture level: MQA reduces it by a factor of h, GQA reduces it by h/G, and MLA compresses it through low-rank projection.

**PagedAttention** (Kwon et al., 2023) [@kwon2023efficient] applies virtual memory concepts to KV-cache management. Instead of allocating a contiguous block of memory for each request's KV-cache (which wastes memory due to fragmentation and over-allocation for variable-length sequences), PagedAttention stores the KV-cache in non-contiguous memory pages that are allocated on demand. This eliminates fragmentation and enables near-optimal memory utilization, increasing serving throughput by 2-4x. **vLLM**, built on PagedAttention, has become the standard open-source LLM serving framework.

**KV-cache compression** methods dynamically reduce the cache size during generation:
- **H2O (Heavy-Hitter Oracle)** (Zhang et al., 2023) [@zhang2024h2o] identifies "heavy hitter" tokens (those that receive high attention scores across many subsequent queries) and retains only these in the cache, evicting less-attended tokens. The paper demonstrates that retaining a 20% KV-cache budget achieves strong performance while evicting the remaining 80% of entries.
- **ScissorHands** (Liu et al., 2024) [@liu2024scissorhands] applies a similar principle, finding that attention patterns exhibit a "persistence of importance" property: tokens that are important for early queries tend to remain important for later queries, enabling reliable cache eviction decisions.
- **SnapKV** (Li et al., 2024) [@li2024snapkv] combines intelligent attention-based KV selection with a compact representation that achieves strong compression ratios while preserving generation quality for long-context tasks.

These three methods differ mainly in how they decide which entries to keep. H2O evicts based on accumulated attention across past queries (a heavy-hitter criterion), ScissorHands relies on the persistence of importance over time to predict which tokens will stay relevant, and SnapKV selects entries by aggregating attention within a recent observation window. In practice, the accumulated-attention and persistence approaches suit streaming generation where importance is judged on the fly, whereas SnapKV's observation-window selection is geared toward compressing a long prompt before decoding begins.

### Continuous Batching and Serving Systems

Efficient serving requires maximizing GPU utilization across multiple concurrent requests. **Static batching** (processing a fixed batch of requests to completion before starting a new batch) wastes throughput because shorter requests must wait for longer ones to finish, leaving GPU resources idle.

**Continuous batching** (also called iteration-level batching) was introduced by **Orca** (Yu et al., 2022) [@yu2022orca], which dynamically adds new requests to a running batch as soon as slots become available and removes completed requests immediately. This maximizes GPU utilization by ensuring that the batch is always full, achieving 2-36x higher throughput than static batching.

**Disaggregated serving** separates the prefill phase (processing the input prompt, compute-bound) from the decode phase (generating tokens one by one, memory-bandwidth-bound) onto different GPU pools optimized for each workload. Splitwise (Patel et al., 2024) [@patel2024splitwise] demonstrated that disaggregation achieves 1.4x higher throughput at 20% lower cost, or 2.35x more throughput under the same power and cost budget, compared to serving both phases on the same GPUs.

**SGLang** (Zheng et al., 2024) [@zheng2024sglang] introduced **RadixAttention**, which shares KV-cache entries across requests that share common prefixes (e.g., system prompts, few-shot examples). By organizing the KV-cache as a radix tree, SGLang avoids redundant computation for shared prefixes, achieving significant speedups for multi-turn conversations and few-shot prompting workloads.

### Efficient Serving for PEFT Models

**S-LoRA** (Sheng et al., 2024) [@sheng2024slora] optimizes serving when multiple LoRA adapters are deployed simultaneously (multi-tenant serving). S-LoRA stores all LoRA adapters in main memory and dynamically loads the relevant adapters into GPU memory for each request, using custom CUDA kernels for batched LoRA computation that can process requests with different adapters in the same batch. This enables serving hundreds or thousands of personalized models from a single GPU, each with a different LoRA adapter, with minimal overhead compared to serving the base model alone.

### Compilation and Runtime Optimization

Beyond algorithmic improvements, compilation and runtime techniques can significantly improve inference speed:

**torch.compile** and **TorchInductor** use ahead-of-time compilation to fuse operations, eliminate memory copies, and generate optimized GPU kernels. For LLM inference, compilation can achieve 1.5-2x speedups over eager execution by eliminating Python overhead and fusing small operations into larger, more efficient kernels.

**TensorRT-LLM** (NVIDIA) provides optimized inference kernels specifically designed for LLM architectures, including fused attention operations, optimized MoE routing, and quantized computation kernels. TensorRT-LLM is optimized for high throughput on NVIDIA hardware.
