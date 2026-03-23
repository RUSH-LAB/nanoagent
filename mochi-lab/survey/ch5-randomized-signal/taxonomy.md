---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

The methods surveyed in this chapter can be organized into:

1. **Random projections and dimensionality reduction:** JL transforms, random features, structured projections
2. **Randomized regularization and training:** Dropout, stochastic depth, DropBlock, random augmentation, initialization
3. **Hashing for machine learning:** LSH, SimHash, learning-to-hash, SLIDE
4. **Sketching and streaming:** Count-Min Sketch, CountSketch, streaming PCA, gradient compression
5. **Probabilistic data structures:** Bloom filters, learned indices, HyperLogLog, reservoir sampling
6. **Fourier and spectral perspectives:** Fourier features, spectral analysis, FNet, AFNO
7. **Wavelet and multi-resolution analysis:** Scattering networks, WaveMix
8. **Signal processing view of Transformers:** Attention as filtering, positional encoding as frequency representation, randomized attention (Performer, Reformer)
9. **Randomized linear algebra:** Randomized SVD, Nystrom, CUR decomposition

These families are deeply interconnected. For example, Performer (category 8) uses random features (category 1) to approximate the attention kernel, and Reformer (category 8) uses locality-sensitive hashing (category 3) to identify relevant key-value pairs. The signal processing perspective (categories 6-8) provides the theoretical framework for understanding why these approximations work and when they fail.
