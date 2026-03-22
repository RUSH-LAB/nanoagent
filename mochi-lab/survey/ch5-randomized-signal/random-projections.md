---
sidebar_position: 4
title: "Random Projections & Dimensionality Reduction"
---

# Random Projections & Dimensionality Reduction

### The Johnson-Lindenstrauss Lemma

The Johnson-Lindenstrauss (JL) lemma [@johnson1984extensions] is one of the most powerful tools in high-dimensional geometry. It states that any set of n points in high-dimensional space can be projected into O(log(n) / epsilon^2) dimensions while preserving all pairwise distances within a factor of (1 +/- epsilon). The projection can be performed by a random matrix, making it computationally cheap.

In machine learning, JL projections are used for: dimensionality reduction of embeddings, compressed sensing of sparse signals, privacy-preserving data release, and fast approximate nearest neighbor search. The practical impact is enormous: a dataset of 1 million 768-dimensional BERT embeddings can be projected to 256 dimensions with less than 5% distance distortion [@dasgupta2003elementary].

### Random Features for Kernel Approximation

Rahimi and Recht (2007) [@rahimi2007random] introduced Random Fourier Features, which approximate shift-invariant kernels (e.g., Gaussian RBF) using explicit random feature maps. Instead of computing kernel values implicitly through the kernel trick, random features map inputs to a finite-dimensional space where inner products approximate kernel evaluations:

k(x, y) approximately equals phi(x)^T * phi(y)

where phi(x) = sqrt(2/D) * [cos(w_1^T x + b_1), ..., cos(w_D^T x + b_D)] and the w_i are sampled from the kernel's spectral density.

This work, which received the Test of Time Award at NeurIPS 2017, enabled kernel methods to scale to large datasets by converting them to linear methods in the random feature space. The error decreases as O(1/sqrt(D)) with the number of random features D [@rahimi2009weighted].

### Structured Random Projections

Unstructured random projections (dense random matrices) are simple but expensive to apply: O(nd) for projecting n d-dimensional points. Structured random projections -- using FFT-based constructions (Fastfood, SRHT), sparse random matrices, or circulant matrices -- achieve the same theoretical guarantees with O(n * d * log(d)) or O(n * nnz) computation [@ailon2006fast, @le2013fastfood].

Yu et al. (2016) [@yu2016orthogonal] proposed Orthogonal Random Features, which use orthogonalized random matrices instead of i.i.d. random matrices for kernel approximation, achieving strictly lower variance. Choromanski et al. (2021) [@choromanski2021rethinking] extended this idea to FAVOR+ (Fast Attention Via positive Orthogonal Random features), connecting random features directly to efficient attention computation in Transformers (see Performer, discussed in Section 5.10).
