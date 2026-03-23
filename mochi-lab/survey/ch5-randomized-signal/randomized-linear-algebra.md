---
sidebar_position: 11
title: "Randomized Linear Algebra for AI"
---

# Randomized Linear Algebra for AI

Randomized numerical linear algebra (RandNLA) has emerged as a powerful paradigm for computing approximate matrix decompositions at scale [@martinsson2020randomized, @woodruff2014sketching]. The core strategy is to use random projections to reduce the problem dimension, compute exact decompositions on the smaller problem, and lift the result back to the original space. This approach provides strong theoretical guarantees (additive or multiplicative error bounds) with computational savings that can be exponential.

### Randomized SVD

Computing the exact Singular Value Decomposition of large matrices is O(min(mn^2, m^2n)) -- prohibitive for the massive matrices encountered in AI. Halko et al. (2011) [@halko2011finding] developed the randomized SVD, which computes an approximate rank-k SVD in O(mn * log(k)) time by projecting the matrix onto a random subspace of dimension k + p (where p is a small oversampling parameter, typically 5-10). The algorithm proceeds in three steps: (1) form a random matrix Omega of size n x (k+p), (2) compute the sketch Y = A * Omega and find an orthonormal basis Q for range(Y), and (3) compute the SVD of the small matrix B = Q^T * A and recover the approximate SVD of A. The oversampling parameter p provides robustness: with p = 5, the approximation error is within a factor (1 + 11*sqrt(k+p)*sqrt(min(m,n))) of optimal, and in practice the error is typically within 1% of the best rank-k approximation.

The randomized SVD is now the default algorithm for large-scale matrix factorization in scientific computing (it is the algorithm behind scikit-learn's TruncatedSVD and Facebook's PCA implementation for billion-scale embeddings). In AI, it is widely used for:

- **Low-rank adaptation (LoRA initialization):** LoRA's low-rank weight updates A*B are conceptually related to the randomized SVD's low-rank factorization. Initializing LoRA with the top-k SVD components of the pretrained weight matrix can provide a warm start.
- **Model compression via low-rank factorization:** Replacing a weight matrix W with its rank-k approximation U_k * Sigma_k * V_k^T reduces parameters from m*n to (m+n)*k, enabling compression ratios of 2-5x with minimal quality loss when the weight matrix has rapid singular value decay.
- **Analyzing learned representations:** PCA of hidden activations reveals the effective dimensionality and structure of learned representations. The randomized SVD enables this analysis on activations with millions of dimensions.
- **Data preprocessing (PCA on large datasets):** Computing PCA on datasets with millions of samples and thousands of features requires the randomized SVD -- exact SVD is infeasible at this scale.

### Nystrom Approximation

The Nystrom method [@williams2001nystrom] approximates a large kernel matrix by sampling a subset of its columns, computing the exact kernel on this subset, and extrapolating to the full matrix. For an n x n kernel matrix, Nystrom reduces computation from O(n^3) to O(n * k^2) where k is the number of sampled columns. Nystrom approximations are used in:

- Kernel learning with large datasets
- Gaussian process inference
- Spectral clustering
- Approximating attention matrices (Nystromformer [@xiong2021nystromformer])

Xiong et al. (2021) [@xiong2021nystromformer] proposed Nystromformer, which applies the Nystrom method to approximate the softmax attention matrix. By sampling a subset of "landmark" tokens and computing attention only with respect to these landmarks, Nystromformer achieves linear complexity while maintaining competitive performance.

### Matrix Completion

Candes and Recht (2009) [@candes2009exact] showed that low-rank matrices can be exactly recovered from a small number of randomly observed entries, provided the matrix satisfies certain incoherence conditions. This result, known as exact matrix completion, has profound implications for recommendation systems (recovering a user-item rating matrix from sparse observations) and other collaborative filtering problems. Recht (2011) [@recht2011simpler] provided a simpler proof and practical algorithms. The connection to randomized algorithms is fundamental: the observed entries must be randomly (not adversarially) selected, and the recovery algorithms use nuclear norm minimization or iterative SVD -- both connected to the randomized linear algebra tools described above.

### CUR Decomposition

CUR decomposition factorizes a matrix M as M approximately equals C * U * R, where C consists of actual columns of M, R consists of actual rows of M, and U is a small linking matrix [@mahoney2009cur]. Unlike SVD, CUR preserves the sparsity and interpretability of the original matrix. Clarkson and Woodruff (2017) [@clarkson2017low] showed that CUR decomposition can be computed in input-sparsity time (linear in the number of nonzeros), making it particularly efficient for sparse matrices common in recommendation systems and NLP. In AI, CUR decomposition has been applied to:

- Interpretable dimensionality reduction (selected features are actual data points)
- Model compression (selecting actual neurons/filters to keep)
- Data summarization (selecting representative examples)
