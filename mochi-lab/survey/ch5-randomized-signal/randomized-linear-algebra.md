---
sidebar_position: 11
title: "Randomized Linear Algebra for AI"
---

# Randomized Linear Algebra for AI

### Randomized SVD

Computing the exact Singular Value Decomposition of large matrices is O(min(mn^2, m^2n)) -- prohibitive for the massive matrices encountered in AI. Halko et al. (2011) [@halko2011finding] developed the randomized SVD, which computes an approximate rank-k SVD in O(mn * log(k)) time by projecting the matrix onto a random subspace of dimension k + p (where p is a small oversampling parameter). The randomized SVD is now standard in scientific computing and is widely used in AI for:

- Low-rank adaptation (LoRA initialization)
- Model compression via low-rank factorization
- Analyzing learned representations
- Data preprocessing (PCA on large datasets)

### Nystrom Approximation

The Nystrom method [@williams2001nystrom] approximates a large kernel matrix by sampling a subset of its columns, computing the exact kernel on this subset, and extrapolating to the full matrix. For an n x n kernel matrix, Nystrom reduces computation from O(n^3) to O(n * k^2) where k is the number of sampled columns. Nystrom approximations are used in:

- Kernel learning with large datasets
- Gaussian process inference
- Spectral clustering
- Approximating attention matrices (Nystromformer [@xiong2021nystromformer])

Xiong et al. (2021) [@xiong2021nystromformer] proposed Nystromformer, which applies the Nystrom method to approximate the softmax attention matrix. By sampling a subset of "landmark" tokens and computing attention only with respect to these landmarks, Nystromformer achieves linear complexity while maintaining competitive performance.

### CUR Decomposition

CUR decomposition factorizes a matrix M as M approximately equals C * U * R, where C consists of actual columns of M, R consists of actual rows of M, and U is a small linking matrix [@mahoney2009cur]. Unlike SVD, CUR preserves the sparsity and interpretability of the original matrix. In AI, CUR decomposition has been applied to:

- Interpretable dimensionality reduction (selected features are actual data points)
- Model compression (selecting actual neurons/filters to keep)
- Data summarization (selecting representative examples)
