---
sidebar_position: 4
title: "Efficient Attention"
---

## Efficient Attention

The self-attention mechanism in Transformers has O(n^2) time and memory complexity in sequence length n, creating a bottleneck for long sequences [@vaswani2017attention].

### Sparse Attention

Sparse attention patterns reduce computation by attending to only a subset of positions. Child et al. (2019) [@child2019generating] introduced Sparse Transformers with fixed stride and local attention patterns achieving O(n * sqrt(n)) complexity. BigBird (Zaheer et al., 2020) [@zaheer2020bigbird] combined random, window, and global attention patterns to achieve linear complexity while retaining theoretical expressiveness (Turing completeness). Longformer (Beltagy et al., 2020) [@beltagy2020longformer] used a similar combination of local windowed attention and task-specific global attention for long document processing.

### Linear Attention

Linear attention mechanisms replace the softmax attention kernel with linear dot-product operations, reducing complexity from O(n^2) to O(n). Katharopoulos et al. (2020) [@katharopoulos2020transformers] showed that attention can be reformulated as a linear dot-product of kernel feature maps, enabling causal attention computation in O(n) time using the associative property of matrix multiplication. However, linear attention often suffers from reduced expressiveness compared to softmax attention [@keles2023computational].

### FlashAttention

Dao et al. (2022, 2023) [@dao2022flashattention, @dao2024flashattention2] introduced FlashAttention, which does not change the mathematical computation but dramatically improves its hardware efficiency. FlashAttention uses tiling and kernel fusion to compute exact attention while minimizing reads/writes to GPU high-bandwidth memory (HBM). FlashAttention-2 [@dao2024flashattention2] further optimized work partitioning across GPU thread blocks, achieving 2x speedup over FlashAttention. FlashAttention-3 (2024) [@shah2024flashattention3] exploits asynchronous operations and tensor cores on Hopper GPUs.

FlashAttention has become the de facto standard for attention computation, demonstrating that IO-aware algorithm design can achieve speedups comparable to algorithmic complexity improvements. It enables training with much longer sequences (up to 64k+ tokens) without approximation.

### Multi-Query and Grouped-Query Attention

Shazeer (2019) [@shazeer2019fast] proposed Multi-Query Attention (MQA), where all attention heads share a single set of key-value projections while maintaining separate query projections. This dramatically reduces the KV-cache size during inference (important for high-throughput serving) with minimal quality loss. Ainslie et al. (2023) [@ainslie2023gqa] proposed Grouped-Query Attention (GQA) as an interpolation between multi-head and multi-query attention, grouping heads to share KV projections. GQA is used in Llama 2 and many subsequent models as a practical balance between quality and inference efficiency.
