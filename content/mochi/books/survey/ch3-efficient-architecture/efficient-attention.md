---
sidebar_position: 4
title: "Efficient Attention"
---

## Efficient Attention

The self-attention mechanism is the core computational primitive of Transformers, enabling each token to attend to all other tokens in the sequence. While this global receptive field is the source of Transformers' remarkable effectiveness, it comes at O(n^2) time and memory cost in sequence length n, creating a fundamental bottleneck for long sequences [@vaswani2017attention]. A 128K-token context window requires computing and storing 16 billion attention scores per layer per head. This section surveys approaches that reduce this cost while preserving (or approximating) the expressive power of full attention. We focus on attention-only modifications that preserve the Transformer architecture; full-architecture replacements (such as state-space models) are covered in sibling sections.

### Sparse Attention Patterns

The key observation motivating sparse attention is that learned attention matrices are often approximately sparse: most attention weight is concentrated on a small fraction of positions [@child2019generating]. If the model learns to attend primarily to nearby tokens and a few global positions, we can design attention patterns that hardcode this structure, computing only the attended-to pairs.

**Sparse Transformers** (Child et al., 2019) [@child2019generating] introduced fixed sparse attention patterns for autoregressive models, factoring the attention computation into two complementary patterns: local (each position attends to a fixed window of nearby positions) and strided (each position attends to every k-th position). This factorization reduces complexity from O(n^2) to O(n * sqrt(n)). Sparse Transformers enabled the generation of high-resolution images and long audio sequences that were previously intractable for standard attention.

**Longformer** (Beltagy et al., 2020) [@beltagy2020longformer] designed a sliding-window attention pattern augmented with task-specific global attention tokens (e.g., the [CLS] token attends to all positions and all positions attend to [CLS]). This combination of local and global attention achieves linear O(n) complexity while maintaining the ability to aggregate information globally. Longformer demonstrated that this simple pattern is sufficient for long document understanding tasks (QA, coreference resolution), processing documents up to 4,096 tokens compared to BERT's 512-token limit.

**BigBird** (Zaheer et al., 2020) [@zaheer2020bigbird] provided theoretical grounding for sparse attention by combining random attention (each position attends to a random subset of other positions), window attention (local context), and global attention (a small number of positions attend to all others). The key theoretical contribution was proving that this combination is **Turing complete** and can approximate any sequence-to-sequence function, matching the theoretical expressiveness of full attention. BigBird extended the context window to 4,096+ tokens for encoder models with minimal quality loss on NLP benchmarks.

**Reformer** (Kitaev et al., 2020) [@kitaev2020reformer] took a different approach, using **locality-sensitive hashing (LSH)** to identify which key-query pairs would have high attention scores, then computing attention only for those pairs. LSH attention achieves O(n log n) complexity by grouping similar queries and keys into the same hash buckets. Reformer also introduced reversible layers (an application of the reversible network idea from [@gomez2017reversible]) to reduce memory from O(n * L) to O(n) by recomputing activations during the backward pass instead of storing them.

### Linear Attention

Linear attention mechanisms replace the softmax attention kernel with a linear function, enabling reformulation that reduces complexity from O(n^2) to O(n). The key insight is that standard attention computes:

Attention(Q, K, V) = softmax(QK^T / sqrt(d)) V

If we replace the softmax with a kernel function phi such that softmax(q^T k) is approximately phi(q)^T phi(k), then attention can be rewritten as:

Attention(Q, K, V) = phi(Q) (phi(K)^T V) / (phi(Q) phi(K)^T 1)

The critical trick is that phi(K)^T V can be computed once in O(n * d^2) time (the "kernel trick"), after which each query's attention output costs only O(d^2). This changes the overall complexity from O(n^2 d) to O(n d^2), which is linear in sequence length n.

**Katharopoulos et al. (2020)** [@katharopoulos2020transformers] demonstrated this reformulation using simple feature maps (elu(x) + 1), showing that linear attention can be computed causally using a recurrent formulation, making it suitable for autoregressive generation. However, the approximation quality depends heavily on the choice of kernel feature map, and linear attention often suffers from reduced expressiveness compared to softmax attention, particularly on tasks requiring sharp, selective attention patterns [@keles2023computational].

**Random Feature Attention (RFA)** (Peng et al., 2021) [@peng2021random_feature_attention] used random Fourier features to approximate the softmax kernel more accurately, providing an unbiased estimator of softmax attention with linear complexity. While theoretically principled, the approximation requires a large number of random features to achieve high accuracy, limiting practical speedups.

**Performers** (Choromanski et al., 2021) [@choromanski2021rethinking] introduced FAVOR+ (Fast Attention Via positive Orthogonal Random features), using orthogonal random features to approximate softmax attention with provably lower variance than standard random feature approaches. Performers achieve unbiased estimation of the full attention matrix with linear time and space complexity, and were among the first linear attention methods demonstrated at scale.

### FlashAttention: IO-Aware Exact Attention

**FlashAttention** (Dao et al., 2022) [@dao2022flashattention] took a fundamentally different approach to efficient attention: rather than approximating the attention computation, it computes **exact** attention while dramatically improving hardware efficiency. The key insight is that the bottleneck of attention is not computation but **memory IO** (reading and writing the large attention matrix to GPU high-bandwidth memory, or HBM).

FlashAttention uses **tiling** to decompose the attention computation into blocks that fit in GPU SRAM (on-chip memory, which is ~10-100x faster than HBM but ~1000x smaller). Each tile computes a partial attention result, and these are combined using the online softmax trick (maintaining a running maximum for numerical stability). By performing all computation within SRAM without materializing the full n x n attention matrix in HBM, FlashAttention reduces HBM accesses from O(n^2) to O(n^2 d^2 / M), where d is the head dimension and M is the SRAM size. Because d^2 (with d typically 64-128) is much smaller than M (on the order of 100KB), this yields a large reduction in memory traffic, achieving roughly 2.4-3x wall-clock speedups over standard attention implementations on GPT-2 and long-range-arena workloads as reported by Dao et al.

**FlashAttention-2** (Dao, 2023) [@dao2023flashattention2] further optimized work partitioning across GPU thread blocks, reducing non-matmul FLOPs and improving parallelism within each attention head. FlashAttention-2 achieved up to 2x speedup over FlashAttention, reaching 50-73% of theoretical maximum FLOPs throughput on A100 GPUs.

**FlashAttention-3** (Shah et al., 2024) [@shah2024flashattention3] exploits the asynchronous execution capabilities and new Tensor Core operations on NVIDIA Hopper GPUs (H100), including warp-group-level operations and asynchronous data movement. FlashAttention-3 achieves a 1.5-2.0x speedup over FlashAttention-2 on H100 GPUs, reaching about 75% utilization in FP16 (740 TFLOPs/s), with particular improvements for FP8 attention computation (close to 1.2 PFLOPs/s).

FlashAttention has become the de facto standard for attention computation across the industry. Its impact extends beyond raw speedup: by eliminating the O(n^2) memory requirement (the attention matrix is never materialized), FlashAttention enables training with much longer sequences (up to 64K-128K+ tokens) without approximation. FlashAttention demonstrates a broader principle: IO-aware algorithm design, meaning designing algorithms around the memory hierarchy rather than just minimizing FLOP count, can achieve speedups comparable to or exceeding algorithmic complexity improvements.

### Multi-Query and Grouped-Query Attention

During autoregressive generation, the key-value cache (KV-cache) grows linearly with sequence length and becomes a major memory bottleneck. With standard multi-head attention (MHA), each head maintains its own key and value projections, resulting in a KV-cache of size O(n * h * d) where h is the number of heads and d is the head dimension.

**Multi-Query Attention (MQA)** (Shazeer, 2019) [@shazeer2019fast] proposed sharing a single set of key-value projections across all attention heads while maintaining separate query projections. This reduces the KV-cache by a factor of h (e.g., 32x for a 32-head model). The quality preservation is surprising and suggests that the diversity of attention patterns is primarily in the queries, not the keys and values. The aggressive sharing is not free, however: collapsing all heads onto a single key-value projection can degrade quality on some tasks and tends to make training less stable than MHA, which motivated the intermediate designs that followed.

**Grouped-Query Attention (GQA)** (Ainslie et al., 2023) [@ainslie2023gqa] provides an interpolation between MHA and MQA by grouping heads into G groups (typically G = 4 or G = 8), with each group sharing a single set of key-value projections. GQA offers a tunable tradeoff between quality (more groups = closer to MHA) and efficiency (fewer groups = closer to MQA). Importantly, Ainslie et al. showed that a model trained with MHA can be converted to GQA through "uptraining" (a small amount of additional training with the grouped structure), enabling existing models to gain efficiency without training from scratch. GQA has been adopted in Llama 2, Llama 3, Mistral, Gemma, and most subsequent production LLMs.

### Multi-Head Latent Attention (MLA)

**Multi-Head Latent Attention (MLA)** (DeepSeek-V2, 2024) [@deepseek2024deepseekv2] introduced a novel approach to KV-cache compression that achieves even greater efficiency than GQA. Instead of sharing keys and values across heads, MLA projects keys and values into a low-dimensional latent space before the attention computation. The KV-cache stores only the low-dimensional latent vectors (dimension d_c, much smaller than h * d), achieving substantial compression while maintaining quality through learned upward projections at attention time. MLA also incorporates rotary position embeddings (RoPE) in a way that is compatible with the compressed cache. DeepSeek-V2 reported that MLA reduces KV-cache size by 93.3% relative to the dense DeepSeek 67B baseline while matching or exceeding its quality on standard benchmarks, and boosts maximum generation throughput by up to 5.76x, enabling longer context windows and higher throughput. The main cost is implementation complexity: because standard RoPE is incompatible with the low-rank latent compression, MLA requires a decoupled RoPE design that adds extra query and key dimensions carrying position information, complicating the attention kernel relative to MHA or GQA.

### Ring Attention and Distributed Context

**Ring Attention** (Liu et al., 2024) [@liu2024ringattention] distributes the attention computation across multiple devices by arranging them in a ring topology and overlapping computation with communication. Each device holds a chunk of the query-key-value tensors and computes attention for its local queries against a circulating block of keys and values. As each device finishes computing attention with the current key-value block, it sends the block to the next device in the ring and receives a new block from the previous device.

This approach enables near-linear scaling of context length with the number of devices: with 8 devices, the effective context window is 8x larger than a single device can support. Ring Attention is particularly important for applications requiring very long contexts (entire codebases, full books, or long videos) where even FlashAttention cannot fit the KV-cache on a single device. Combined with FlashAttention for within-device computation, Ring Attention enables context windows of millions of tokens. The tradeoff is that it introduces inter-device communication into the attention path: each step transfers a key-value block around the ring, so its efficiency depends on overlapping that communication with computation. When the per-device chunk is small or interconnect bandwidth is limited, communication latency is exposed and scaling falls short of the ideal linear speedup.

### Differential Attention

**Differential Attention** (Ye et al., 2024) [@ye2024diff_transformer] proposed the Diff Transformer, which computes attention as the **difference** between two separate softmax attention maps:

DiffAttn(Q, K, V) = (softmax(Q_1 K_1^T / sqrt(d)) - lambda * softmax(Q_2 K_2^T / sqrt(d))) V

where Q_1, Q_2, K_1, K_2 are separate projections and lambda is a learnable scalar. The subtraction effectively cancels out attention noise: the low-value, broadly distributed attention that standard softmax assigns to irrelevant tokens. The result is a sparser, more focused attention pattern that attends more precisely to relevant information.

Diff Transformer achieves better performance than standard Transformers on language modeling and downstream tasks, with particularly strong improvements on tasks requiring precise information retrieval from long contexts (e.g., key-value retrieval, multi-hop reasoning over long documents). The differential mechanism can be understood as a form of learned noise cancellation, analogous to differential amplifiers in electronics or common-mode rejection in sensor design. Its cost is computational rather than asymptotic: Diff Transformer still scales as O(n^2) like full attention and requires computing two softmax maps and a second set of query and key projections, so it does not reduce the core complexity that the other methods in this section target.

### Native Sparse Attention

**Native Sparse Attention (NSA)** (Yuan et al., 2025) [@yuan2025native_sparse_attention] introduced a hardware-aligned sparse attention mechanism that combines compressed global attention with fine-grained token selection. NSA reports substantial speedups over full attention on 64K-length sequences across decoding, forward, and backward passes while maintaining quality on long-context tasks, demonstrating that sparse attention patterns can be designed to be both algorithmically efficient and hardware-friendly on modern GPU architectures. As an approximate (sparse) method, however, it forgoes the exactness of full attention: its quality depends on the compression and token-selection heuristics, and realizing the speedups requires the hardware-aligned kernel design rather than a drop-in replacement for dense attention.

### Cross-Family Tradeoffs

The efficient attention families surveyed in this section make different tradeoffs along orthogonal axes. **Sparse attention methods** (Sparse Transformers, Longformer, BigBird, Reformer) trade exactness for asymptotic complexity reduction, preserving the attention mechanism while computing only a subset of scores. **Linear attention** (Katharopoulos et al., RFA, Performers) pushes this trade further, replacing the softmax kernel to achieve linear scaling, but at the cost of expressiveness on tasks requiring sharp selectivity. **FlashAttention** demonstrates the alternative path: preserving exact attention while optimizing for memory IO rather than FLOP count, achieving practical speedups without approximation. **KV-cache compression methods** (MQA, GQA, MLA) target a different bottleneck (inference-time memory), trading key-value diversity or implementation complexity for reduced cache size. **Ring Attention** extends context length by distributing computation across devices, trading communication latency for scale. **Differential Attention** improves quality through noise cancellation but does not reduce the O(n^2) cost. Each family optimizes for a different regime: train-time compute (sparse, linear), train-time memory (FlashAttention), inference-time memory (MQA/GQA/MLA), extreme context length (Ring), or quality at fixed cost (Differential). The choice depends on the deployment setting and which resource (compute, memory, communication) is the limiting factor.
