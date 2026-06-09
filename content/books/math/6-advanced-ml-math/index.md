# Advanced ML Math

Modern ML architectures reach for tools beyond linear algebra and basic calculus: spectral graph theory, stochastic differential equations, and optimal transport. This chapter develops those foundations and connects each to the architecture that motivates it.

**Prerequisites.** These sections assume the core math built up earlier in this book: [linear algebra](../3-linear-algebra/index.md) (eigendecomposition and SVD in particular), [calculus and optimization](../4-calculus-and-optimization/index.md), and [probability and statistics](../5-probability-and-statistics/index.md). The four sections below are largely independent, so you can read them in any order.

- **[Attention and Transformers](./1-attention-and-transformers.md)**: Scaled dot-product attention, multi-head attention, positional encoding, FlashAttention
- **[Diffusion Models](./2-diffusion-models.md)**: Forward noise process, reverse denoising, DDPM loss, score matching
- **[Graph Neural Networks](./3-graph-neural-networks.md)**: Graph Laplacian, spectral theory, message passing, GCN/GAT
- **[Optimal Transport](./4-optimal-transport.md)**: Wasserstein distance, Kantorovich duality, Sinkhorn algorithm
