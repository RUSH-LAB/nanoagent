---
sidebar_position: 13
title: "Benchmarks & Theoretical Results"
---

# Benchmarks & Theoretical Results

### Approximation Guarantees

The theoretical foundations of randomized algorithms for AI rest on well-established results:

- **JL Lemma:** O(epsilon^{-2} * log n) dimensions suffice for epsilon-distortion of n points [@johnson1984extensions]
- **Random Features:** O(epsilon^{-2}) features suffice for epsilon-approximation of shift-invariant kernels [@rahimi2007random, @rahimi2009weighted]
- **LSH:** (c*r, r, p1, p2)-sensitive hash families enable c-approximate nearest neighbor in sub-linear time [@indyk1998approximate]
- **CountSketch:** O(epsilon^{-2}) space suffices for epsilon-accurate frequency estimation in streams [@charikar2004finding]
- **Randomized SVD:** O(k + p) random samples achieve near-optimal rank-k approximation [@halko2011finding]

### Empirical Speedups

Practical speedups reported in the literature include:
- SLIDE: 3.5x faster than GPU training on CPU for recommendation models [@chen2020slide]
- Random features: 100x speedup over exact kernel methods on large datasets [@rahimi2007random]
- Randomized SVD: 10-100x faster than exact SVD for low-rank approximation [@halko2011finding]
- FNet: 80% faster training than BERT with 92% of accuracy [@leethorp2022fnet]
- Nystromformer: Linear scaling with sequence length while maintaining 95%+ of standard attention quality [@xiong2021nystromformer]
