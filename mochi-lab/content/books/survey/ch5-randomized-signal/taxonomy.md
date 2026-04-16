---
sidebar_position: 3
title: "Taxonomy of Approaches"
---

# Taxonomy of Approaches

The methods surveyed in this chapter can be organized into nine interconnected families, spanning classical randomized algorithms, signal processing theory, and their applications in modern AI:

1. **Random projections and dimensionality reduction:** The Johnson-Lindenstrauss lemma [@johnson1984extensions, @achlioptas2003database] provides the theoretical foundation: high-dimensional data can be projected to O(epsilon^{-2} log n) dimensions while preserving all pairwise distances to within (1 +/- epsilon). This underlies random Fourier features for kernel approximation [@rahimi2007random], compressed sensing [@donoho2006compressed, @candes2006robust], and structured random projections for efficient embedding.

2. **Randomized regularization and training:** Dropout [@srivastava2014dropout], stochastic depth [@huang2016deep], DropBlock, random data augmentation, and stochastic gradient descent [@robbins1951stochastic] with its variants (Adam [@kingma2015adam], AdaGrad). These methods use randomness to prevent overfitting, improve generalization, and enable scalable optimization. The theoretical connections to ensemble learning (dropout as exponential ensembling) and Bayesian inference (dropout as approximate variational inference [@gal2016dropout]) provide principled justifications for these widely used techniques.

3. **Hashing for machine learning:** Locality-sensitive hashing (LSH) [@indyk1998approximate], SimHash, MinHash, learning-to-hash methods, and the SLIDE algorithm [@chen2020slide]. Hashing enables sub-linear similarity search and sparse computation, with applications in approximate nearest neighbor search (HNSW [@malkov2020hnsw], FAISS [@johnson2021faiss]) and attention sparsification (Reformer [@kitaev2020reformer]).

4. **Sketching and streaming:** Count-Min Sketch [@cormode2005improved], CountSketch [@charikar2004finding], streaming PCA (Frequent Directions [@liberty2013simple]), and gradient compression [@ivkin2019communication, @spring2019compressing]. These algorithms process data in a single pass with bounded memory, providing the algorithmic foundation for online learning, distributed training, and continual learning.

5. **Probabilistic data structures:** Bloom filters [@bloom1970space] for approximate set membership, HyperLogLog [@flajolet2007hyperloglog] for cardinality estimation, reservoir sampling [@vitter1985random] for maintaining uniform random samples from streams, and consistent hashing [@karger1997consistent] for distributed data management. These structures provide bounded-error guarantees with dramatically reduced memory.

6. **Fourier and spectral perspectives:** Random Fourier features [@rahimi2007random], Fourier neural operators (FNO) [@li2021fourier], AFNO [@guibas2022afno], FNet [@leethorp2022fnet], spectral bias analysis, and the Neural Tangent Kernel's spectral characterization. The Fourier transform provides the mathematical bridge between spatial/temporal patterns and frequency-domain analysis of neural network behavior.

7. **Wavelet and multi-resolution analysis:** Wavelet scattering networks [@bruna2013invariant], WaveMix, and multi-resolution training strategies. Wavelets provide time-frequency localization that the Fourier transform lacks, enabling analysis of signals with features at multiple scales -- directly relevant to neural networks that must capture patterns at different levels of abstraction [@daubechies1992ten].

8. **Signal processing view of Transformers:** Attention as adaptive filtering [@dong2021attention], positional encoding as frequency representation (RoPE [@su2024roformer]), token mixing as convolution, and randomized attention approximations (Performer [@choromanski2021rethinking], Reformer, linear attention [@katharopoulos2020transformers]). This perspective connects the Transformer architecture to the rich theory of adaptive signal processing.

9. **Randomized linear algebra:** Randomized SVD [@halko2011finding, @martinsson2020randomized], Nystrom approximation, CUR decomposition [@clarkson2017low], and matrix completion [@candes2009exact]. These algorithms compute approximate matrix factorizations in time proportional to the matrix size (rather than the matrix rank cubed), enabling efficient low-rank approximation at scale.

These families are deeply interconnected. For example, Performer (category 8) uses random features (category 1) to approximate the attention kernel, and Reformer (category 8) uses locality-sensitive hashing (category 3) to identify relevant key-value pairs. The signal processing perspective (categories 6-8) provides the theoretical framework for understanding why these approximations work and when they fail. Random projections (category 1) underlie both sketching algorithms (category 4) and randomized linear algebra (category 9), as the JL lemma guarantees that random projections preserve the geometric structure needed for downstream computation.
