---
sidebar_position: 11
title: "Randomized Linear Algebra for AI"
---

# Randomized Linear Algebra for AI

Randomized numerical linear algebra (RandNLA) has emerged as a powerful paradigm for computing approximate matrix decompositions at scale [@martinsson2020randomized, @woodruff2014sketching]. The core strategy is to use random projections to reduce the problem dimension, compute exact decompositions on the smaller problem, and lift the result back to the original space. This approach provides strong theoretical guarantees (additive or multiplicative error bounds) with order-of-magnitude computational savings (for example, O(mnk) or O(mn log k) instead of O(min(mn^2, m^2n)) for a rank-k SVD).

### Randomized SVD

Computing the exact Singular Value Decomposition of large matrices is O(min(mn^2, m^2n)), prohibitive for the massive matrices encountered in AI. Halko et al. (2011) [@halko2011finding] developed the randomized SVD, which computes an approximate rank-k SVD by projecting the matrix onto a random subspace of dimension k + p (where p is a small oversampling parameter, typically 5-10). The algorithm proceeds in three steps: (1) form a random matrix Omega of size n x (k+p), (2) compute the sketch Y = A * Omega and find an orthonormal basis Q for range(Y), and (3) compute the SVD of the small matrix B = Q^T * A and recover the approximate SVD of A. With a dense Gaussian Omega the dominant cost is the product A * Omega at O(mnk); using a structured random matrix (such as a subsampled randomized Fourier transform applied via the FFT) reduces this to O(mn * log(k)). The oversampling parameter p provides robustness: Theorem 10.6 of Halko et al. bounds the expected error as E||A - Q Q^T A|| <= (1 + 4*sqrt(k+p)/(p-1) * sqrt(min(m,n))) * sigma_{k+1}, where sigma_{k+1} is the optimal rank-k spectral-norm error, and in practice the error is typically within a few percent of the best rank-k approximation.

The randomized SVD has become a standard algorithm for large-scale matrix factorization in scientific computing (for example, scikit-learn's TruncatedSVD exposes a randomized solver alongside an ARPACK option). In AI, it is widely used for:

- **Low-rank adaptation (LoRA initialization):** LoRA [@hu2022lora] learns additive low-rank weight deltas rather than an SVD of the weight matrix itself, so the link to randomized SVD is structural rather than algorithmic. That said, SVD-based initialization is a concrete technique: PiSSA [@meng2024pissa] initializes the adapter from the top-k singular components of the pretrained weight, which has been reported to give faster convergence than the standard random LoRA initialization.
- **Model compression via low-rank factorization:** Replacing a weight matrix W with its rank-k approximation U_k * Sigma_k * V_k^T reduces parameters from m*n to (m+n)*k, enabling compression ratios of 2-5x with minimal quality loss when the weight matrix has rapid singular value decay.
- **Analyzing learned representations:** PCA of hidden activations reveals the effective dimensionality and structure of learned representations. The randomized SVD enables this analysis on activations with millions of dimensions.
- **Data preprocessing (PCA on large datasets):** Computing PCA on datasets with millions of samples and thousands of features requires the randomized SVD, since exact SVD is infeasible at this scale.

### Nystrom Approximation

The Nystrom method [@williams2001nystrom] approximates a large kernel matrix by sampling a subset of its columns, computing the exact kernel on this subset, and extrapolating to the full matrix. For an n x n kernel matrix, Nystrom reduces computation from O(n^3) to roughly O(nk^2 + k^3) where k is the number of sampled columns: O(nk) to evaluate the sampled kernel entries, O(k^3) to invert (pseudoinvert) the k x k block, and O(nk^2) to form the approximation. The accuracy hinges on how the k columns are sampled: uniform sampling is cheap but can miss important directions, while leverage-score sampling gives stronger error guarantees at higher sampling cost. This sampling-quality versus sampling-cost tension is the central tradeoff for Nystrom. Nystrom approximations are used in:

- Kernel learning with large datasets
- Gaussian process inference
- Spectral clustering
- Approximating attention matrices (Nystromformer [@xiong2021nystromformer])

Xiong et al. (2021) [@xiong2021nystromformer] proposed Nystromformer, which applies the Nystrom method to approximate the softmax attention matrix. By sampling a subset of "landmark" tokens and computing attention only with respect to these landmarks, Nystromformer achieves linear complexity while maintaining competitive performance.

### Matrix Completion

Candes and Recht (2009) [@candes2009exact] showed that low-rank matrices can be exactly recovered from a small number of randomly observed entries, provided the matrix satisfies certain incoherence conditions. This result, known as exact matrix completion, has profound implications for recommendation systems (recovering a user-item rating matrix from sparse observations) and other collaborative filtering problems. Recht (2011) [@recht2011simpler] provided a simpler proof and practical algorithms. The connection to randomized algorithms is fundamental: the observed entries must be randomly (not adversarially) selected, and the recovery algorithms use nuclear norm minimization or iterative SVD, both connected to the randomized linear algebra tools described above.

### CUR Decomposition

CUR decomposition factorizes a matrix M as M approximately equals C * U * R, where C consists of actual columns of M, R consists of actual rows of M, and U is a small linking matrix [@mahoney2009cur]. Unlike SVD, CUR preserves the sparsity and interpretability of the original matrix. Clarkson and Woodruff (2017) [@clarkson2017low] showed that CUR decomposition can be computed in input-sparsity time (linear in the number of nonzeros), making it particularly efficient for sparse matrices common in recommendation systems and NLP. In AI, CUR decomposition has been applied to:

- Interpretable dimensionality reduction (selected features are actual data points)
- Model compression (selecting actual neurons/filters to keep)
- Data summarization (selecting representative examples)

### Choosing Among the Methods

These methods trade accuracy, interpretability, and structural assumptions against one another, so the right choice depends on the matrix and the downstream goal. Randomized SVD gives the most accurate low-rank approximation (within a small factor of the optimal rank-k error, per Halko et al.'s Theorem 10.6) at O(mnk) for a Gaussian sketch or O(mn log k) for a structured sketch, but its factors U, Sigma, V are dense linear combinations of the original rows and columns and are therefore hard to interpret. CUR sacrifices some approximation quality to keep C and R made of actual columns and rows, preserving sparsity and interpretability (selected columns or rows correspond to real features, neurons, or examples); it is the method to reach for when the identity of the chosen components matters or when input-sparsity-time computation on sparse matrices is needed. Nystrom is the specialization for symmetric positive semidefinite kernel matrices: it reduces O(n^3) kernel work to roughly O(nk^2 + k^3), at the cost of accuracy that depends heavily on the column-sampling scheme (uniform vs leverage-score). As a rule of thumb: prefer randomized SVD for dense low-rank approximation and PCA, CUR when interpretability or sparsity preservation is the priority, and Nystrom when the object of interest is a large kernel or attention matrix.
