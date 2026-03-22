# Chapter 5: Randomized Algorithms, Data Structures & Signal Processing Perspectives of AI

## 5.1 Introduction & Motivation

Deep learning is often presented as a purely data-driven enterprise, but beneath the surface, many of its most effective techniques are rooted in classical randomized algorithms, probabilistic data structures, and signal processing theory. Understanding these connections is not merely academic -- it reveals principled ways to design more efficient, theoretically grounded, and interpretable AI systems [1, 2, 3].

Randomized algorithms provide approximation guarantees that often match the practical performance of exact methods while being orders of magnitude cheaper. The Johnson-Lindenstrauss lemma tells us that high-dimensional data can be projected to much lower dimensions while preserving distances; locality-sensitive hashing enables sub-linear similarity search; sketching algorithms summarize streaming data in bounded memory. These classical tools, developed decades before the deep learning revolution, are now finding new life as components of modern AI systems [4, 5].

Signal processing theory offers a complementary lens. Transformers can be understood as learned filter banks; positional encodings are frequency representations; attention is a form of adaptive filtering. The spectral theory of neural networks -- analyzing what frequencies networks learn, and in what order -- provides insights into generalization, optimization, and architecture design [6, 7, 8].

This chapter surveys these connections, organized into three broad themes: randomized algorithms applied to AI, signal processing perspectives on neural networks, and probabilistic data structures for AI systems. Our goal is to bridge the conceptual gap between these classical fields and modern deep learning, highlighting both established tools and emerging research directions.

## 5.2 Problem Formulation

### Approximation Guarantees

Many AI tasks can be formulated as optimization or estimation problems where exact solutions are computationally intractable. Randomized algorithms provide (epsilon, delta)-approximations: with probability at least 1 - delta, the output is within a factor of (1 + epsilon) of the optimal solution. The key insight is that for many problems, achieving epsilon = 0.01 requires exponentially less computation than achieving epsilon = 0 [1, 9].

### Probabilistic Analysis of Neural Networks

Viewing neural networks through a probabilistic lens enables analysis techniques from random matrix theory, high-dimensional probability, and statistical learning theory. Key questions include: How do random initializations affect training dynamics? What is the expected behavior of networks with random weights? How do randomized training procedures (dropout, data augmentation, stochastic depth) improve generalization? [10, 11]

### Computational vs. Statistical Tradeoffs

A recurring theme is the tradeoff between computational efficiency and statistical accuracy. Randomized methods often achieve near-optimal statistical performance with dramatically reduced computational cost. Understanding these tradeoffs -- when approximation is acceptable and how much accuracy we sacrifice -- is critical for designing practical AI systems [12].

## 5.3 Taxonomy of Approaches

The methods surveyed in this chapter can be organized into:

1. **Random projections and dimensionality reduction:** JL transforms, random features, structured projections
2. **Hashing for machine learning:** LSH, SimHash, learning-to-hash
3. **Sketching and streaming:** Count-Min Sketch, CountSketch, streaming PCA
4. **Probabilistic data structures:** Bloom filters, learned indices, HyperLogLog
5. **Fourier and spectral perspectives:** Fourier features, spectral analysis, FNet
6. **Wavelet and multi-resolution analysis:** Scattering networks, WaveMix
7. **Signal processing view of Transformers:** Attention as filtering, frequency analysis
8. **Randomized linear algebra:** Randomized SVD, Nystrom, CUR decomposition

## 5.4 Random Projections & Dimensionality Reduction

### 5.4.1 The Johnson-Lindenstrauss Lemma

The Johnson-Lindenstrauss (JL) lemma [13] is one of the most powerful tools in high-dimensional geometry. It states that any set of n points in high-dimensional space can be projected into O(log(n) / epsilon^2) dimensions while preserving all pairwise distances within a factor of (1 +/- epsilon). The projection can be performed by a random matrix, making it computationally cheap.

In machine learning, JL projections are used for: dimensionality reduction of embeddings, compressed sensing of sparse signals, privacy-preserving data release, and fast approximate nearest neighbor search. The practical impact is enormous: a dataset of 1 million 768-dimensional BERT embeddings can be projected to 256 dimensions with less than 5% distance distortion [14].

### 5.4.2 Random Features for Kernel Approximation

Rahimi and Recht (2007) [15] introduced Random Fourier Features, which approximate shift-invariant kernels (e.g., Gaussian RBF) using explicit random feature maps. Instead of computing kernel values implicitly through the kernel trick, random features map inputs to a finite-dimensional space where inner products approximate kernel evaluations:

k(x, y) approximately equals phi(x)^T * phi(y)

where phi(x) = sqrt(2/D) * [cos(w_1^T x + b_1), ..., cos(w_D^T x + b_D)] and the w_i are sampled from the kernel's spectral density.

This work, which received the Test of Time Award at NeurIPS 2017, enabled kernel methods to scale to large datasets by converting them to linear methods in the random feature space. The error decreases as O(1/sqrt(D)) with the number of random features D [16].

### 5.4.3 Structured Random Projections

Unstructured random projections (dense random matrices) are simple but expensive to apply: O(nd) for projecting n d-dimensional points. Structured random projections -- using FFT-based constructions (Fastfood, SRHT), sparse random matrices, or circulant matrices -- achieve the same theoretical guarantees with O(n * d * log(d)) or O(n * nnz) computation [17, 18].

Yu et al. (2016) [19] proposed Orthogonal Random Features, which use orthogonalized random matrices instead of i.i.d. random matrices for kernel approximation, achieving strictly lower variance. Choromanski et al. (2021) [20] extended this idea to FAVOR+ (Fast Attention Via positive Orthogonal Random features), connecting random features directly to efficient attention computation in Transformers (see Performer, discussed in Section 5.10).

## 5.5 Hashing for Machine Learning

### 5.5.1 Locality-Sensitive Hashing (LSH)

Locality-Sensitive Hashing [21] is a family of randomized hash functions where similar items hash to the same bucket with high probability, while dissimilar items collide with low probability. The classic LSH for cosine similarity uses random hyperplane partitioning (SimHash):

h(x) = sign(r^T x)

where r is a random vector. By using multiple independent hash functions and hash tables, LSH enables sub-linear (approximately O(n^rho) where rho < 1) approximate nearest neighbor search [22].

### 5.5.2 SLIDE: Sub-Linear Deep Learning

Chen et al. (2020) [23] proposed SLIDE (Sub-LInear Deep learning Engine), which uses LSH to identify the most relevant neurons (those with highest activation) for each input, activating only a small subset of the network. SLIDE demonstrated that on CPUs, an LSH-accelerated deep network could outperform GPU-based dense training in wall-clock time. This work showed that randomized algorithms could fundamentally change the compute paradigm for neural networks. G-SLIDE [24] later extended this to GPUs with LSH-based sparse computation.

### 5.5.3 Learning-to-Hash

Rather than using predefined hash functions, learning-to-hash methods train neural networks to produce hash codes optimized for a specific retrieval task [25]. Deep hashing methods learn compact binary representations that preserve semantic similarity, enabling fast retrieval with Hamming distance computation. These methods bridge the gap between classical hashing (with theoretical guarantees) and learned representations (with task-specific optimization).

### 5.5.4 Cross-Polytope Hashing

Andoni et al. (2015) [26] introduced cross-polytope LSH, which hashes points to the nearest vertex of a randomly rotated cross-polytope (the high-dimensional analog of an octahedron). Cross-polytope LSH achieves asymptotically optimal rho values for cosine similarity and is more practically efficient than hyperplane LSH due to better collision probabilities.

## 5.6 Sketching & Streaming

### 5.6.1 Count-Min Sketch and CountSketch

The Count-Min Sketch (Cormode and Muthukrishnan, 2005) [27] and CountSketch (Charikar et al., 2004) [28] are streaming data structures that maintain approximate frequency counts in sub-linear space. These have been adapted for machine learning:

- **Gradient compression:** Ivkin et al. (2019) [29] used Count-Min Sketch for compressing gradients in distributed training, transmitting only a sketch instead of the full gradient vector. This reduces communication cost from O(d) to O(k * log(d/k)) per worker.
- **Feature hashing:** Weinberger et al. (2009) [30] used hashing to reduce feature dimensionality while preserving inner products, a technique widely used in large-scale linear models.

### 5.6.2 CountSketch for Gradient Compression

Spring and Shrivastava (2019) [31] applied CountSketch to compress gradient updates in deep learning training. By sketching the gradient vector into a much smaller data structure, communicating the sketch, and recovering an approximate gradient, they achieved order-of-magnitude communication reduction with minimal impact on convergence. The key insight is that gradient vectors are typically approximately sparse -- a few entries carry most of the magnitude -- making them amenable to sketching.

### 5.6.3 Streaming PCA and Frequent Directions

Streaming PCA algorithms maintain a low-rank approximation of a data matrix seen one row at a time [32]. Liberty (2013) [33] proposed Frequent Directions, a deterministic streaming algorithm for matrix sketching that maintains a small matrix B such that A^T A - B^T B is approximately zero (in the spectral norm sense). Frequent Directions is used in online learning settings where data arrives continuously and batch PCA is infeasible.

### 5.6.4 Reservoir Sampling

Reservoir sampling [34] maintains a uniform random sample of fixed size k from a stream of unknown length. In AI systems, reservoir sampling is used for: data selection in continual learning (maintaining a representative buffer), deduplication pipelines for pre-training data, and online evaluation with fixed memory.

## 5.7 Bloom Filters & Learned Indices

### 5.7.1 Learned Bloom Filters

Kriss et al. (2018) [35] proposed replacing traditional Bloom filters with learned models that predict set membership. A learned Bloom filter trains a small neural network to predict whether an element is in the set, backed by a smaller traditional Bloom filter to handle false negatives. The learned model can exploit distributional properties of the data (e.g., URLs that look like spam) that traditional Bloom filters ignore, achieving lower false-positive rates at the same memory budget.

### 5.7.2 Learned Index Structures

Kraska et al. (2018) [36] introduced the idea of replacing traditional index structures (B-trees, hash maps, Bloom filters) with learned models. The key insight is that an index is fundamentally a function from keys to positions, and neural networks are universal function approximators. A learned B-tree replacement (using a hierarchy of neural networks) can outperform traditional B-trees when the data distribution has learnable structure. This work inspired a rich line of research on learned data structures, including learned hash functions, learned sorting, and learned query optimization [37].

### 5.7.3 Applications in AI Systems

Learned data structures are increasingly used within AI systems themselves:
- Embedding table lookups in recommendation systems
- Approximate nearest neighbor indices for retrieval-augmented generation
- Data deduplication in pre-training pipelines using learned hash functions
- Routing decisions in Mixture-of-Experts models

## 5.8 Fourier & Spectral Perspectives

### 5.8.1 Fourier Features for Neural Networks

Tancik et al. (2020) [38] demonstrated that standard neural networks fail to learn high-frequency functions from low-dimensional inputs due to a spectral bias toward low frequencies (the "frequency bias" or "spectral bias") [39]. Their solution -- mapping inputs through random Fourier features before feeding them to the network -- enables learning of high-frequency content. This was transformative for Neural Radiance Fields (NeRF) and other coordinate-based neural representations, where fine geometric and appearance details require high-frequency function approximation.

The connection to random features (Section 5.4.2) is direct: Fourier feature mappings are instances of random feature maps for the RBF kernel, and the frequency distribution of the random features controls the bandwidth of learnable functions [38].

### 5.8.2 Spectral Analysis of Attention

Self-attention can be analyzed through a spectral lens. The attention matrix, when viewed as a linear operator, has a spectrum that reveals the information flow patterns in the network [40]. Low-rank approximations of attention matrices (motivated by empirical observations of spectral decay) underlie many efficient attention methods. The connection between attention and kernel methods [41] enables the use of random feature approximations for attention (e.g., Performer [20]), linking back to Rahimi and Recht's work.

### 5.8.3 Frequency Bias in Neural Networks

Rahaman et al. (2019) [39] showed that neural networks learn low-frequency components of target functions before high-frequency components -- a phenomenon they called the "spectral bias" or F-principle. This has important implications for architecture design: networks struggle with high-frequency patterns unless explicitly encouraged (via positional encoding, Fourier features, or architectural modifications). Understanding spectral bias helps explain why certain architectures (e.g., those with skip connections or Fourier-based layers) generalize better.

### 5.8.4 FNet

Lee-Thorp et al. (2022) [42] proposed FNet, which replaces the self-attention sublayer in Transformers with a simple Fourier transform (unparameterized 2D DFT over the sequence and hidden dimensions). FNet achieves 92% of BERT's accuracy on GLUE while training 80% faster on GPUs and 70% faster on TPUs. This striking result suggests that much of what attention does can be approximated by fixed spectral mixing operations, connecting Transformer architecture to classical signal processing.

### 5.8.5 Adaptive Fourier Neural Operators

Guibas et al. (2022) [43] proposed AFNO (Adaptive Fourier Neural Operator), which uses parameterized Fourier transforms as token mixing operations in Transformers. Unlike FNet's fixed FFT, AFNO learns channel-mixing weights in the frequency domain, combining the efficiency of spectral methods with the expressiveness of learned parameters. AFNO has been applied to weather forecasting (FourCastNet) and other scientific computing tasks.

## 5.9 Wavelet & Multi-Resolution Analysis

### 5.9.1 Wavelet Scattering Networks

Mallat (2012) [44] introduced the scattering transform, which cascades wavelet transforms with modulus nonlinearities to create representations that are invariant to translations, stable to deformations, and preserve high-frequency discriminative information. Unlike learned convolutions, scattering transforms use predefined wavelets, providing mathematical guarantees on invariance and stability.

Scattering networks have proven effective as feature extractors, especially in low-data regimes where learned features overfit. They also serve as a theoretical framework for understanding what convolutional neural networks learn: deep CNNs can be viewed as learning improved versions of scattering transforms [45].

### 5.9.2 Multi-Scale Representations

Multi-resolution analysis -- processing signals at multiple scales simultaneously -- is fundamental to both wavelets and modern neural networks. U-Net architectures, feature pyramid networks, and multi-scale attention all implement forms of multi-resolution analysis. The wavelet perspective provides theoretical tools (e.g., approximation theory, Besov spaces) for understanding when and why multi-scale representations are beneficial [46].

### 5.9.3 WaveMix

Jeevan and Sethi (2022) [47] proposed WaveMix, which uses 2D discrete wavelet transforms for token mixing in vision architectures. WaveMix decomposes feature maps into multi-resolution subbands using wavelets, processes each subband, and reconstructs the mixed features. This achieves competitive performance with CNNs and Vision Transformers while being more parameter-efficient, demonstrating that classical signal processing operators can serve as effective neural network components.

### 5.9.4 Wavelet-Integrated Deep Networks

A growing body of work integrates wavelet transforms into deep network architectures for tasks including image super-resolution, denoising, generation, and compression [48]. Wavelets provide lossless, invertible decompositions that help networks operate at appropriate scales, reduce spatial resolution without information loss, and inject inductive biases about multi-scale structure.

## 5.10 Signal Processing View of Transformers

### 5.10.1 Attention as Adaptive Filtering

Self-attention can be viewed as a form of adaptive filtering: given input tokens, attention computes data-dependent filter coefficients (attention weights) that determine how information from different positions is combined [7, 49]. From this perspective:

- **Query-key dot products** compute similarity, analogous to matched filtering
- **Softmax normalization** creates a probability distribution over positions, analogous to a normalized filter response
- **Value aggregation** is a weighted sum, analogous to applying the computed filter

This interpretation connects attention to a rich literature on adaptive signal processing, including Wiener filters, Kalman filters, and beamforming [50].

### 5.10.2 Positional Encoding as Frequency Representation

Sinusoidal positional encodings [51] represent position as a combination of sinusoids at different frequencies, directly analogous to a Fourier basis representation. The choice of frequency range determines the length scales the model can distinguish. Rotary Position Embedding (RoPE) [52] extends this by applying rotation matrices to queries and keys, encoding relative position through the interference pattern of complex exponentials -- a technique with close parallels to frequency-domain signal processing.

### 5.10.3 Token Mixing as Convolution

Many efficient Transformer alternatives replace attention with fixed or learned convolution-like operations. From a signal processing perspective, these methods trade the adaptivity of attention (data-dependent filters) for the efficiency of convolution (shared, shift-invariant filters) [42, 53]:

- **FNet** [42]: Uses the DFT, a specific linear convolution in the frequency domain
- **gMLP** [54]: Uses spatial gating units, a form of element-wise multiplication in a projected space
- **Hyena** [55]: Uses data-controlled long convolutions, bridging adaptive attention and fixed convolution

This progression from fixed convolution to data-dependent filtering exactly mirrors the classical signal processing hierarchy from FIR filters to adaptive filters.

## 5.11 Randomized Linear Algebra for AI

### 5.11.1 Randomized SVD

Computing the exact Singular Value Decomposition of large matrices is O(min(mn^2, m^2n)) -- prohibitive for the massive matrices encountered in AI. Halko et al. (2011) [56] developed the randomized SVD, which computes an approximate rank-k SVD in O(mn * log(k)) time by projecting the matrix onto a random subspace of dimension k + p (where p is a small oversampling parameter). The randomized SVD is now standard in scientific computing and is widely used in AI for:

- Low-rank adaptation (LoRA initialization)
- Model compression via low-rank factorization
- Analyzing learned representations
- Data preprocessing (PCA on large datasets)

### 5.11.2 Nystrom Approximation

The Nystrom method [57] approximates a large kernel matrix by sampling a subset of its columns, computing the exact kernel on this subset, and extrapolating to the full matrix. For an n x n kernel matrix, Nystrom reduces computation from O(n^3) to O(n * k^2) where k is the number of sampled columns. Nystrom approximations are used in:

- Kernel learning with large datasets
- Gaussian process inference
- Spectral clustering
- Approximating attention matrices (Nystromformer [58])

Xiong et al. (2021) [58] proposed Nystromformer, which applies the Nystrom method to approximate the softmax attention matrix. By sampling a subset of "landmark" tokens and computing attention only with respect to these landmarks, Nystromformer achieves linear complexity while maintaining competitive performance.

### 5.11.3 CUR Decomposition

CUR decomposition factorizes a matrix M as M approximately equals C * U * R, where C consists of actual columns of M, R consists of actual rows of M, and U is a small linking matrix [59]. Unlike SVD, CUR preserves the sparsity and interpretability of the original matrix. In AI, CUR decomposition has been applied to:

- Interpretable dimensionality reduction (selected features are actual data points)
- Model compression (selecting actual neurons/filters to keep)
- Data summarization (selecting representative examples)

## 5.12 Probabilistic Data Structures in Systems for AI

### 5.12.1 HyperLogLog for Deduplication

HyperLogLog [60] estimates the cardinality (number of distinct elements) of a multiset using O(log log n) space per counter. In AI data pipelines, HyperLogLog is used to estimate dataset diversity, detect near-duplicate documents in pre-training corpora, and monitor vocabulary coverage during tokenizer training. The MinHash variant enables efficient estimation of Jaccard similarity between document sets, powering deduplication pipelines that process trillions of tokens [61].

### 5.12.2 Reservoir Sampling for Data Selection

Vitter's reservoir sampling [34] maintains a uniform random sample of size k from a stream of unknown length. In AI systems, reservoir sampling is used for:

- Maintaining replay buffers in continual learning (see Chapter 1)
- Online data selection during pre-training
- Constructing evaluation sets from streaming data
- Fair sampling for bias evaluation

### 5.12.3 Consistent Hashing for Distributed Training

Consistent hashing [62] enables balanced distribution of data and computation across workers with minimal redistribution when workers are added or removed. In distributed AI training, consistent hashing is used for data parallelism, expert assignment in MoE models, and distributed embedding tables.

## 5.13 Benchmarks & Theoretical Results

### Approximation Guarantees

The theoretical foundations of randomized algorithms for AI rest on well-established results:

- **JL Lemma:** O(epsilon^{-2} * log n) dimensions suffice for epsilon-distortion of n points [13]
- **Random Features:** O(epsilon^{-2}) features suffice for epsilon-approximation of shift-invariant kernels [15, 16]
- **LSH:** (c*r, r, p1, p2)-sensitive hash families enable c-approximate nearest neighbor in sub-linear time [21]
- **CountSketch:** O(epsilon^{-2}) space suffices for epsilon-accurate frequency estimation in streams [28]
- **Randomized SVD:** O(k + p) random samples achieve near-optimal rank-k approximation [56]

### Empirical Speedups

Practical speedups reported in the literature include:
- SLIDE: 3.5x faster than GPU training on CPU for recommendation models [23]
- Random features: 100x speedup over exact kernel methods on large datasets [15]
- Randomized SVD: 10-100x faster than exact SVD for low-rank approximation [56]
- FNet: 80% faster training than BERT with 92% of accuracy [42]
- Nystromformer: Linear scaling with sequence length while maintaining 95%+ of standard attention quality [58]

## 5.14 Open Problems & Future Directions

### Tighter Bounds and Optimal Algorithms

While many randomized algorithms have known approximation guarantees, gaps remain between upper and lower bounds. For example, the optimal number of random features needed for epsilon-accurate kernel approximation in the worst case is still debated [16]. Developing optimal algorithms with matching lower bounds would provide definitive guidance for practitioners.

### Co-Design of Algorithms and Hardware

Randomized algorithms often have irregular memory access patterns (hash table lookups, random projections) that are poorly suited to GPUs optimized for regular, dense computation. Co-designing randomized algorithms with hardware -- or designing hardware that efficiently supports randomized computation -- is an important direction. SLIDE's CPU success [23] hints that the hardware landscape may shift toward supporting sparse, irregular computation.

### Adaptive Randomization

Most randomized methods use data-independent randomization (e.g., random projections drawn once before seeing the data). Data-dependent randomization -- adapting the random maps to the data distribution -- can significantly improve approximation quality. Learning-to-hash is one instance, but the general principle of "learned randomization" is underexplored.

### Theoretical Foundations of Deep Learning Through Random Matrix Theory

Random matrix theory provides tools for analyzing neural networks at initialization, during training, and at convergence [10, 11]. Key open questions include: What do the eigenvalue distributions of weight matrices reveal about generalization? How do random initializations interact with optimization landscape geometry? Can random matrix theory guide architecture design?

### Integration with Foundation Models

As foundation models grow, randomized algorithms become increasingly critical for their training, serving, and adaptation. Understanding how to combine randomized methods (sketching, hashing, random projections, approximate attention) into coherent systems that maintain end-to-end quality guarantees is a systems-level challenge.

## 5.15 Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** Many efficient architecture techniques are directly derived from the methods in this chapter. Linear attention uses random features for kernel approximation [20]; efficient attention uses sparse attention patterns analogous to locality-sensitive hashing; model compression uses randomized SVD and random projections; and state space models can be analyzed through spectral and signal processing lenses.

**Continual Learning (Chapter 1):** Randomized data structures underpin continual learning systems: reservoir sampling for replay buffers, sketching for compressed gradient storage, and random projections for computing parameter importance efficiently. The streaming algorithms perspective (processing data in a single pass with bounded memory) directly models the continual learning setting.

**World Models (Chapter 2):** Spectral methods can analyze the learned dynamics in world models; random projections can compress latent state representations; and randomized planning algorithms (random shooting, CEM with random sampling) are standard tools for planning with world models.

**Agentic Search (Chapter 4):** Approximate nearest neighbor search -- the backbone of dense retrieval in RAG systems -- relies heavily on LSH, random projections, and product quantization. The efficiency of vector databases that power agentic search systems directly depends on the randomized algorithms covered in this chapter.

## References

- [1] Mitzenmacher, M. and Upfal, E. "Probability and Computing: Randomization and Probabilistic Techniques in Algorithms and Data Analysis." Cambridge University Press, 2017.
- [2] Vershynin, R. "High-Dimensional Probability: An Introduction with Applications in Data Science." Cambridge University Press, 2018.
- [3] Woodruff, D.P. "Sketching as a Tool for Numerical Linear Algebra." Foundations and Trends in Theoretical Computer Science, 2014.
- [4] Achlioptas, D. "Database-friendly Random Projections: Johnson-Lindenstrauss with Binary Coins." Journal of Computer and System Sciences, 2003.
- [5] Liu, F., Huang, X., Chen, Y., and Suykens, J.A.K. "Random Features for Kernel Approximation: A Survey on Algorithms, Theory, and Beyond." IEEE TPAMI, 2022. https://ieeexplore.ieee.org/document/9495136
- [6] Mallat, S. "Understanding Deep Convolutional Networks." Phil. Trans. R. Soc. A, 2016.
- [7] Dong, Y., Cordonnier, J.B., and Loukas, A. "Attention is Not All You Need: Pure Attention Loses Rank Doubly Exponentially with Depth." ICML, 2021.
- [8] Tancik, M., Srinivasan, P.P., Mildenhall, B., et al. "Fourier Features Let Networks Learn High Frequency Functions in Low Dimensional Domains." NeurIPS, 2020. https://arxiv.org/abs/2006.10739
- [9] Motwani, R. and Raghavan, P. "Randomized Algorithms." Cambridge University Press, 1995.
- [10] Pennington, J. and Worah, P. "Nonlinear Random Matrix Theory for Deep Learning." NeurIPS, 2017.
- [11] Louart, C., Liao, Z., and Couillet, R. "A Random Matrix Approach to Neural Networks." Annals of Applied Probability, 2018.
- [12] Bottou, L. and Bousquet, O. "The Tradeoffs of Large Scale Learning." NeurIPS, 2008.
- [13] Johnson, W.B. and Lindenstrauss, J. "Extensions of Lipschitz Mappings into a Hilbert Space." Contemporary Mathematics, 1984.
- [14] Dasgupta, S. and Gupta, A. "An Elementary Proof of a Theorem of Johnson and Lindenstrauss." Random Structures & Algorithms, 2003.
- [15] Rahimi, A. and Recht, B. "Random Features for Large-Scale Kernel Machines." NeurIPS, 2007.
- [16] Rahimi, A. and Recht, B. "Weighted Sums of Random Kitchen Sinks: Replacing Minimization with Randomization in Learning." NeurIPS, 2009.
- [17] Ailon, N. and Chazelle, B. "The Fast Johnson-Lindenstrauss Transform and Approximate Nearest Neighbors." STOC, 2006.
- [18] Le, Q., Sarlos, T., and Smola, A. "Fastfood - Approximating Kernel Expansions in Loglinear Time." ICML, 2013.
- [19] Yu, F.X., Suresh, A.T., Choromanski, K., Holtmann-Rice, D., and Kumar, S. "Orthogonal Random Features." NeurIPS, 2016.
- [20] Choromanski, K., Likhosherstov, V., Dohan, D., et al. "Rethinking Attention with Performers." ICLR, 2021.
- [21] Indyk, P. and Motwani, R. "Approximate Nearest Neighbors: Towards Removing the Curse of Dimensionality." STOC, 1998.
- [22] Andoni, A. and Indyk, P. "Near-Optimal Hashing Algorithms for Approximate Nearest Neighbor in High Dimensions." FOCS, 2006.
- [23] Chen, B., Dao, T., Winsor, E., Song, Z., Rudra, A., and Re, C. "SLIDE: In Defense of Smart Algorithms over Hardware Acceleration for Large-Scale Deep Learning Systems." MLSys, 2020.
- [24] Chen, B., et al. "G-SLIDE: A GPU-Based Sub-Linear Deep Learning Engine via LSH Sparsification." IEEE TPDS, 2022. https://ieeexplore.ieee.org/document/9635657
- [25] Wang, J., Zhang, T., Song, J., Sebe, N., and Shen, H.T. "A Survey on Learning to Hash." IEEE TPAMI, 2018.
- [26] Andoni, A., Indyk, P., Laarhoven, T., Razenshteyn, I., and Schmidt, L. "Practical and Optimal LSH for Angular Distance." NeurIPS, 2015.
- [27] Cormode, G. and Muthukrishnan, S. "An Improved Data Stream Summary: The Count-Min Sketch and Its Applications." Journal of Algorithms, 2005.
- [28] Charikar, M., Chen, K., and Farach-Colton, M. "Finding Frequent Items in Data Streams." Theoretical Computer Science, 2004.
- [29] Ivkin, N., Rothchild, D., Ullah, E., et al. "Communication-efficient Distributed SGD with Sketching." NeurIPS, 2019.
- [30] Weinberger, K., Dasgupta, A., Langford, J., Smola, A., and Attenberg, J. "Feature Hashing for Large Scale Multitask Learning." ICML, 2009.
- [31] Spring, R. and Shrivastava, A. "Compressing Gradient Optimizers via Count-Sketches." ICML, 2019. https://proceedings.mlr.press/v97/spring19a.html
- [32] Oja, E. "Simplified Neuron Model as a Principal Component Analyzer." Journal of Mathematical Biology, 1982.
- [33] Liberty, E. "Simple and Deterministic Matrix Sketching." KDD, 2013.
- [34] Vitter, J.S. "Random Sampling with a Reservoir." ACM Transactions on Mathematical Software, 1985.
- [35] Kriss, M., Mitzenmacher, M., and Vassilvitskii, S. "Adaptive Cuckoo Filters." ALENEX, 2018.
- [36] Kraska, T., Beutel, A., Chi, E.H., Dean, J., and Polyzotis, N. "The Case for Learned Index Structures." SIGMOD, 2018. https://arxiv.org/abs/1712.01208
- [37] Ferragina, P. and Vinciguerra, G. "The PGM-index: A Fully-dynamic Compressed Learned Index with Provable Worst-case Bounds." VLDB, 2020.
- [38] Tancik, M., et al. "Fourier Features Let Networks Learn High Frequency Functions in Low Dimensional Domains." NeurIPS, 2020.
- [39] Rahaman, N., Baratin, A., Arpit, D., et al. "On the Spectral Bias of Neural Networks." ICML, 2019.
- [40] Bhojanapalli, S., Yun, C., Rawat, A.S., Reddi, S., and Kumar, S. "Low-Rank Bottleneck in Multi-head Attention Models." ICML, 2020.
- [41] Tsai, Y.H.H., Bai, S., Poczos, B., Kolter, J.Z., and Salakhutdinov, R. "Transformer Dissection: An Unified Understanding for Transformer's Attention via the Lens of Kernel." EMNLP, 2019.
- [42] Lee-Thorp, J., Ainslie, J., Eckstein, I., and Ontanon, S. "FNet: Mixing Tokens with Fourier Transforms." NAACL, 2022.
- [43] Guibas, J., Mardani, M., Li, Z., et al. "Adaptive Fourier Neural Operators: Efficient Token Mixers for Transformers." ICLR, 2022. https://arxiv.org/abs/2111.13587
- [44] Mallat, S. "Group Invariant Scattering." Communications on Pure and Applied Mathematics, 2012.
- [45] Bruna, J. and Mallat, S. "Invariant Scattering Convolution Networks." IEEE TPAMI, 2013.
- [46] Mallat, S. "A Wavelet Tour of Signal Processing." Academic Press, 2008.
- [47] Jeevan, P. and Sethi, A. "WaveMix: A Resource-efficient Neural Network for Image Analysis." arXiv:2205.14375, 2022. https://arxiv.org/abs/2205.14375
- [48] Liu, P., et al. "Wavelet-integrated Deep Neural Networks: A Systematic Review." Neurocomputing, 2025. https://www.sciencedirect.com/science/article/pii/S0925231225023203
- [49] Cordonnier, J.B., Loukas, A., and Jaggi, M. "On the Relationship between Self-Attention and Convolutional Layers." ICLR, 2020.
- [50] Haykin, S. "Adaptive Filter Theory." Prentice Hall, 2002.
- [51] Vaswani, A., Shazeer, N., Parmar, N., et al. "Attention Is All You Need." NeurIPS, 2017.
- [52] Su, J., Lu, Y., Pan, S., Murtadha, A., Wen, B., and Liu, Y. "RoFormer: Enhanced Transformer with Rotary Position Embedding." Neurocomputing, 2024.
- [53] Gu, A. and Dao, T. "Mamba: Linear-Time Sequence Modeling with Selective State Spaces." arXiv:2312.00752, 2024.
- [54] Liu, H., Dai, Z., So, D., and Le, Q.V. "Pay Attention to MLPs." NeurIPS, 2021.
- [55] Poli, M., Massaroli, S., Nguyen, E., et al. "Hyena Hierarchy: Towards Larger Convolutional Language Models." ICML, 2023.
- [56] Halko, N., Martinsson, P.G., and Tropp, J.A. "Finding Structure with Randomness: Probabilistic Algorithms for Constructing Approximate Matrix Decompositions." SIAM Review, 2011.
- [57] Williams, C.K.I. and Seeger, M. "Using the Nystrom Method to Speed Up Kernel Machines." NeurIPS, 2001.
- [58] Xiong, Y., Zeng, Z., Chakraborty, R., et al. "Nystromformer: A Nystrom-Based Algorithm for Approximating Self-Attention." AAAI, 2021.
- [59] Mahoney, M.W. and Drineas, P. "CUR Matrix Decompositions for Improved Data Analysis." PNAS, 2009.
- [60] Flajolet, P., Fusy, E., Gandouet, O., and Meunier, F. "HyperLogLog: The Analysis of a Near-Optimal Cardinality Estimation Algorithm." DMTCS Proceedings, 2007.
- [61] Lee, K., et al. "Deduplicating Training Data Makes Language Models Better." ACL, 2022.
- [62] Karger, D., Lehman, E., Leighton, T., et al. "Consistent Hashing and Random Trees: Distributed Caching Protocols for Relieving Hot Spots on the World Wide Web." STOC, 1997.
