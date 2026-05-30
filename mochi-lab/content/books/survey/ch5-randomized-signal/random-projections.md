---
sidebar_position: 4
title: "Random Projections & Dimensionality Reduction"
---

# Random Projections & Dimensionality Reduction

### The Johnson-Lindenstrauss Lemma

The Johnson-Lindenstrauss (JL) lemma [@johnson1984extensions] is one of the most powerful tools in high-dimensional geometry. It states that any set of n points in high-dimensional space can be projected into O(log(n) / epsilon^2) dimensions while preserving all pairwise distances within a factor of (1 +/- epsilon). The projection can be performed by a random matrix, making it computationally cheap. The tightness of the dimension bound was established by later work [@matousek2008variants, @larsen2017optimality], showing that O(log(n) / epsilon^2) is essentially optimal for general point sets.

In machine learning, JL projections are used for: dimensionality reduction of embeddings, compressed sensing of sparse signals, privacy-preserving data release, and fast approximate nearest neighbor search. The dimension bound is what makes this practical. Note that the target dimension grows only logarithmically in the number of points but scales as 1/epsilon^2 in the accuracy. For example, with n = 1 million points, the O(log(n) / epsilon^2) bound at epsilon = 0.05 (5% distortion) calls for on the order of log(10^6) / 0.05^2 approximately 5500 dimensions (with a constant near 1), so reaching a substantially lower target such as a few hundred dimensions trades a larger distortion for the savings. In practice the achievable distortion at a fixed target dimension depends on the data distribution and is often better than this worst-case bound, but the worst-case guarantee scales as described.

### Compressed Sensing

Compressed sensing [@donoho2006compressed, @candes2006robust] demonstrates that sparse signals can be exactly recovered from far fewer measurements than the Nyquist rate requires, provided the measurement matrix satisfies the Restricted Isometry Property (RIP). Random matrices (Gaussian, Bernoulli, or structured random matrices) satisfy RIP with high probability, directly connecting compressed sensing to random projections. Specifically, an m x n random Gaussian matrix satisfies the RIP of order k with high probability when m = O(k * log(n/k)), meaning that any k-sparse signal can be exactly recovered from only O(k * log(n/k)) measurements, far fewer than the signal dimension n (linear in k up to a log factor, versus the ambient dimension n).

The implications for AI are significant. Compressed sensing enables efficient data acquisition (useful for sensor networks and medical imaging, where MRI scan times can be substantially reduced using compressed sensing reconstruction [@lustig2007sparse]), and the same principles underlie sparse representation learning and feature selection in machine learning. The iterative algorithms used for compressed sensing recovery (basis pursuit (L1 minimization), iterative hard thresholding, and CoSaMP) have inspired analogous algorithms for sparse neural network training (the lottery ticket hypothesis [@frankle2019lottery] can be viewed through the compressed sensing lens: a sparse subnetwork can represent the same function as the dense network because the weight structure is approximately sparse).

The connection to neural network pruning is particularly illuminating. If the weight matrix of a trained network is approximately k-sparse (has approximately k significant entries), then the RIP theory suggests that random measurements of the weight matrix preserve enough information to reconstruct the sparse structure, providing an analogy (though not a direct theoretical guarantee) for random-projection-based pruning and distillation methods.

### Random Features for Kernel Approximation

Rahimi and Recht (2007) [@rahimi2007random] introduced Random Fourier Features, which approximate shift-invariant kernels (e.g., Gaussian RBF) using explicit random feature maps. Instead of computing kernel values implicitly through the kernel trick, random features map inputs to a finite-dimensional space where inner products approximate kernel evaluations:

k(x, y) approximately equals phi(x)^T * phi(y)

where phi(x) = sqrt(2/D) * [cos(w_1^T x + b_1), ..., cos(w_D^T x + b_D)] and the w_i are sampled from the kernel's spectral density.

This work, which received the Test of Time Award at NeurIPS 2017, enabled kernel methods to scale to large datasets by converting them to linear methods in the random feature space. The error decreases as O(1/sqrt(D)) with the number of random features D [@rahimi2007random], with sharper finite-sample bounds given by later analysis [@sutherland2015error].

### Structured Random Projections

Unstructured random projections (dense random matrices) are simple but expensive to apply: O(nd) for projecting n d-dimensional points. Structured random projections, using FFT-based constructions (Fastfood, SRHT), sparse random matrices, or circulant matrices, achieve the same theoretical guarantees with O(n * d * log(d)) or O(n * nnz) computation [@ailon2006fast, @le2013fastfood].

Yu et al. (2016) [@yu2016orthogonal] proposed Orthogonal Random Features, which use orthogonalized random matrices instead of i.i.d. random matrices for kernel approximation, achieving strictly lower variance for the Gaussian kernel in the regime where the number of features is comparable to or exceeds the data dimension. Choromanski et al. (2021) [@choromanski2021rethinking] extended this idea to FAVOR+ (Fast Attention Via positive Orthogonal Random features), connecting random features directly to efficient attention computation in Transformers (see Performer, discussed in Section 5.10).
