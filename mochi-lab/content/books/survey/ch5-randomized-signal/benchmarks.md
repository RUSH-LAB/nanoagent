---
sidebar_position: 13
title: "Benchmarks & Theoretical Results"
---

# Benchmarks & Theoretical Results

### Approximation Guarantees

The theoretical foundations of randomized algorithms for AI rest on well-established results with precise, tight bounds:

- **Johnson-Lindenstrauss Lemma:** O(epsilon^{-2} * log n) dimensions suffice for epsilon-distortion of all pairwise distances among n points [@johnson1984extensions]. This bound is tight: Omega(epsilon^{-2} * log n) dimensions are necessary in the worst case [@larsen2017optimality]. For typical AI applications (n = 10^6, epsilon = 0.1), the standard bound k >= (8 * ln n) / epsilon^2 requires projecting to roughly 11,000 dimensions to preserve all pairwise distances to within 10% (the exact target depends on the constant in the chosen JL variant).

- **Random Fourier Features:** O(epsilon^{-2}) features suffice for epsilon-approximation of shift-invariant kernels (Gaussian RBF, Laplacian, etc.) in terms of the maximum deviation of kernel values [@rahimi2007random, @rahimi2009weighted]. The approximation error is uniform over the domain, providing worst-case guarantees. The constants depend on the kernel bandwidth and the data dimensionality.

- **Locality-Sensitive Hashing:** (c*r, r, p1, p2)-sensitive hash families enable c-approximate nearest neighbor search in sub-linear time O(n^rho) where rho = log(1/p1)/log(1/p2) [@indyk1998approximate]. For cosine similarity with SimHash, rho = 1/c, achieving approximately O(n^{1/c}) query time for c-approximate nearest neighbors. Cross-polytope LSH achieves asymptotically optimal rho values [@andoni2015practical].

- **CountSketch and Count-Min Sketch:** O(epsilon^{-2} * log(1/delta)) space suffices for epsilon-accurate frequency estimation of all elements in a stream with probability 1 - delta [@charikar2004finding, @cormode2005improved]. The space is independent of the stream length, making these structures suitable for processing arbitrarily long data streams.

- **Randomized SVD:** O(k + p) random projections (where p is a small oversampling parameter, typically 5-10) yield a rank-k approximation that satisfies ||A - A_k||_F <= (1 + epsilon) * ||A - A_k^*||_F in expectation, where A_k^* is the optimal rank-k approximation [@halko2011finding]. The bound assumes sufficiently rapid spectral decay and tightens with larger oversampling p and with additional power iterations. The computation is O(mn * (k + p)) for an m x n matrix, compared to O(mn * min(m,n)) for exact SVD.

- **Nystrom Approximation:** Sampling k columns yields a rank-k kernel matrix approximation whose expected error scales informally as O(n/k * sum_{i>k} sigma_i) where sigma_i are the eigenvalues [@williams2001nystrom, @gittens2016revisiting]. The constant and the exact rate depend on the sampling scheme: uniform column sampling gives the loosest guarantee, while leverage-score sampling tightens the bound at the cost of precomputation. The expression should be read as a scaling guide rather than a scheme-independent tight bound. For matrices with rapid eigenvalue decay (typical for kernel matrices from smooth kernels), small k suffices.

### Empirical Speedups and Quality-Efficiency Tradeoffs

Practical speedups reported in the literature demonstrate the real-world impact of these theoretical guarantees. Each row below is an instance of one of the chapter's taxonomy families: SLIDE and Reformer from the hashing family, Random Features and Performer from the random-projection and Fourier families, Randomized SVD from the randomized-linear-algebra family, FNet and Nystromformer from the signal-processing-view-of-Transformers family, and gradient sketching from the sketching and streaming family.

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

The "Quality Retention" figures are drawn from the cited papers' own reported results and are **not cross-comparable across rows**: each uses a different metric, dataset, and baseline (for example, "92% of BERT" refers to FNet's accuracy relative to BERT on GLUE [@leethorp2022fnet], while "99%+" for Randomized SVD refers to reconstruction error in the Frobenius norm relative to the optimal rank-k approximation [@halko2011finding]). The speedups are likewise reported under different hardware and sequence-length regimes. Readers should treat each row as evidence from a single study's protocol rather than as a head-to-head comparison; controlled side-by-side evaluation requires fixing the task, dataset, and baseline, which the per-task benchmarks below are designed to provide.

### Benchmark Tasks for Evaluation

Evaluating randomized methods for AI requires task-specific benchmarks:

- **Approximate Nearest Neighbor:** ANN-Benchmarks [@aumuller2020annbenchmarks] provides standardized evaluation of approximate nearest neighbor algorithms across datasets (MNIST, GloVe, SIFT, Deep) and metrics (recall@k at various throughput levels). This benchmark has driven the development of HNSW, IVF, and quantization-based indices used in RAG systems.

- **Long Range Arena (LRA)** [@tay2021long] evaluates efficient sequence models on tasks requiring long-range dependencies, directly testing randomized attention approximations.

- **Kernel Approximation Quality:** Evaluated on standard kernel benchmark datasets (MNIST, CIFAR, protein folding) by measuring the gap between exact kernel methods and random feature approximations at various feature counts.

- **Streaming Quality:** Evaluated on streaming data benchmarks by measuring approximation quality (relative error of frequency estimates, similarity estimates) as a function of sketch size.

Each benchmark stresses a different family from the chapter taxonomy, and the tradeoffs they expose differ accordingly. ANN-Benchmarks targets the **hashing and projection** families (LSH, HNSW, quantization), where the controlling tradeoff is recall against query throughput, so it rewards methods that index well rather than those with the tightest worst-case bounds. Long Range Arena targets the **signal-processing-view-of-Transformers** family (Performer, Reformer, FNet, Nystromformer), where the tradeoff is accuracy against sequence-length scaling, making it the benchmark that separates near-linear attention approximations from quadratic baselines. Kernel approximation quality targets the **Fourier and random-features** family, where the tradeoff is the feature count against the kernel-value error predicted by the O(epsilon^{-2}) bound. Streaming quality targets the **sketching, streaming, and probabilistic-data-structure** families, where the tradeoff is sketch size against estimation error, isolating the space-accuracy frontier independent of stream length. Taken together, these benchmarks show that no single axis ranks the methods: a technique that dominates the recall-throughput frontier (hashing) says nothing about its position on the accuracy-scaling frontier (attention), which is why the speedup figures above are reported per family rather than pooled.
