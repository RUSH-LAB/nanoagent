---
sidebar_position: 13
title: "Benchmarks & Theoretical Results"
---

# Benchmarks & Theoretical Results

### Approximation Guarantees

The theoretical foundations of randomized algorithms for AI rest on well-established results with precise, tight bounds:

- **Johnson-Lindenstrauss Lemma:** O(epsilon^{-2} * log n) dimensions suffice for epsilon-distortion of all pairwise distances among n points [@johnson1984extensions]. This bound is tight: Omega(epsilon^{-2} * log n) dimensions are necessary in the worst case [@larsen2017optimality]. For typical AI applications (n = 10^6, epsilon = 0.1), this means projecting from any dimension to approximately 600 dimensions preserves all distances to within 10%.

- **Random Fourier Features:** O(epsilon^{-2}) features suffice for epsilon-approximation of shift-invariant kernels (Gaussian RBF, Laplacian, etc.) in terms of the maximum deviation of kernel values [@rahimi2007random, @rahimi2009weighted]. The approximation error is uniform over the domain, providing worst-case guarantees. The constants depend on the kernel bandwidth and the data dimensionality.

- **Locality-Sensitive Hashing:** (c*r, r, p1, p2)-sensitive hash families enable c-approximate nearest neighbor search in sub-linear time O(n^rho) where rho = log(1/p1)/log(1/p2) [@indyk1998approximate]. For cosine similarity with SimHash, rho = 1/c, achieving approximately O(n^{1/c}) query time for c-approximate nearest neighbors. Cross-polytope LSH achieves asymptotically optimal rho values [@andoni2015practical].

- **CountSketch and Count-Min Sketch:** O(epsilon^{-2} * log(1/delta)) space suffices for epsilon-accurate frequency estimation of all elements in a stream with probability 1 - delta [@charikar2004finding, @cormode2005improved]. The space is independent of the stream length, making these structures suitable for processing arbitrarily long data streams.

- **Randomized SVD:** O(k + p) random projections (where p is a small oversampling parameter, typically 5-10) yield a rank-k approximation that satisfies ||A - A_k||_F <= (1 + epsilon) * ||A - A_k^*||_F where A_k^* is the optimal rank-k approximation [@halko2011finding]. The computation is O(mn * (k + p)) for an m x n matrix, compared to O(mn * min(m,n)) for exact SVD.

- **Nystrom Approximation:** Sampling k columns yields a rank-k kernel matrix approximation with expected error O(n/k * sum_{i>k} sigma_i) where sigma_i are the eigenvalues [@williams2001nystrom, @gittens2016revisiting]. For matrices with rapid eigenvalue decay (typical for kernel matrices from smooth kernels), small k suffices.

### Empirical Speedups and Quality-Efficiency Tradeoffs

Practical speedups reported in the literature demonstrate the real-world impact of these theoretical guarantees:

| Method | Domain | Speedup | Quality Retention |
|--------|--------|---------|-------------------|
| SLIDE [@chen2020slide] | Training (recommendation) | 3.5x CPU vs GPU | Equal accuracy |
| Random Features [@rahimi2007random] | Kernel methods | 100x on large datasets | 95-99% |
| Randomized SVD [@halko2011finding] | Matrix factorization | 10-100x | 99%+ |
| FNet [@leethorp2022fnet] | NLP (BERT replacement) | 80% faster training | 92% of BERT |
| Performer [@choromanski2021rethinking] | Attention approximation | 2-4x on long sequences | 95-99% |
| Nystromformer [@xiong2021nystromformer] | Attention approximation | Linear scaling | 95%+ |
| Reformer [@kitaev2020reformer] | Long sequence modeling | O(n log n) vs O(n^2) | 95-98% |
| Gradient sketching [@ivkin2019communication] | Distributed training comm. | 10-100x compression | Convergence preserved |

### Benchmark Tasks for Evaluation

Evaluating randomized methods for AI requires task-specific benchmarks:

- **Approximate Nearest Neighbor:** ANN-benchmarks (Aumuller et al., 2020) provides standardized evaluation of approximate nearest neighbor algorithms across datasets (MNIST, GloVe, SIFT, Deep) and metrics (recall@k at various throughput levels). This benchmark has driven the development of HNSW, IVF, and quantization-based indices used in RAG systems.

- **Long Range Arena (LRA)** (Tay et al., 2021) [@tay2021long] evaluates efficient sequence models on tasks requiring long-range dependencies, directly testing randomized attention approximations.

- **Kernel Approximation Quality:** Evaluated on standard kernel benchmark datasets (MNIST, CIFAR, protein folding) by measuring the gap between exact kernel methods and random feature approximations at various feature counts.

- **Streaming Quality:** Evaluated on streaming data benchmarks by measuring approximation quality (relative error of frequency estimates, similarity estimates) as a function of sketch size.
