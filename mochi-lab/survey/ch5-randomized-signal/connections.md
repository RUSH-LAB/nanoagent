---
sidebar_position: 15
title: "Connections to Other Chapters"
---

# Connections to Other Chapters

**Efficient Architecture Design (Chapter 3):** The connections between randomized algorithms and efficient architectures are among the deepest in this survey, as many efficiency techniques are direct applications of randomized methods:

- *Linear attention via random features:* Performer [@choromanski2021rethinking] uses FAVOR+ (random Fourier features with orthogonal random matrices) to approximate softmax attention in O(n) time, directly applying the random feature framework from Section 5.4.
- *Sparse attention via hashing:* Reformer [@kitaev2020reformer] uses locality-sensitive hashing from Section 5.5 to identify relevant key-value pairs, reducing attention from O(n^2) to O(n log n).
- *Model compression via randomized linear algebra:* Low-rank factorization for model compression uses randomized SVD from Section 5.11. LoRA's low-rank weight updates are conceptually related to randomized low-rank approximation.
- *Quantization as randomized rounding:* Stochastic rounding in quantization-aware training is a randomized algorithm with provable unbiasedness guarantees.
- *Gradient compression via sketching:* CountSketch-based gradient compression from Section 5.6 directly enables communication-efficient distributed training.
- *State space models and signal processing:* The HiPPO initialization of SSMs (S4, Mamba) is grounded in polynomial projection operators with connections to spectral methods from Section 5.8.
- *FlashAttention and IO complexity:* While FlashAttention is not a randomized algorithm, its IO-complexity analysis draws on the same mathematical framework (bounding memory access patterns) used to analyze randomized streaming algorithms.

**Continual Learning (Chapter 1):** Randomized data structures are essential infrastructure for continual learning systems:

- *Reservoir sampling for replay buffers:* The theoretical foundation for maintaining unbiased samples in experience replay (Section 5.6) directly underlies the buffer management strategies in continual learning, ensuring that replay buffers remain representative as the data stream evolves.
- *Sketching for compressed replay:* Count-Min Sketch and related structures can compress replay buffers, storing approximate representations of previous task distributions in bounded memory rather than storing raw examples.
- *Random projections for parameter importance:* EWC-style continual learning methods require computing the Fisher information matrix, which is prohibitively expensive for large models. Random projections enable efficient approximation of parameter importance without materializing the full Fisher matrix.
- *Streaming PCA for representation tracking:* Gradient Projection Memory (GPM) from Chapter 1 maintains a basis for each task's representation subspace. Streaming PCA algorithms (Frequent Directions) from Section 5.6 provide the algorithmic machinery for maintaining these bases efficiently.
- *The streaming perspective:* Online continual learning -- processing data in a single pass with bounded memory -- is formally equivalent to the streaming computation model that motivates sketching and sampling algorithms.

**World Models (Chapter 2):** Spectral methods and randomized algorithms connect to world models in several ways:

- *Spectral analysis of learned dynamics:* The dynamics models learned by world models (Dreamer, IRIS) can be analyzed through spectral decomposition, revealing the timescales and modes of the learned dynamics. The eigenspectrum of the transition model determines which dynamical features are captured.
- *Random projections for state compression:* World model latent states can be compressed using random projections while preserving dynamical properties, enabling more memory-efficient world model training and inference.
- *Randomized planning:* Planning with world models uses randomized methods extensively: Cross-Entropy Method (CEM) samples random action sequences and selects the best; random shooting generates random rollouts for Monte Carlo estimation; MCTS uses random simulations for value estimation.
- *Fourier analysis of temporal patterns:* The spectral bias of neural networks has implications for world model learning: world models may learn low-frequency temporal patterns (slow dynamics) before high-frequency ones (fast dynamics), with implications for training curriculum design.

**Agentic Search (Chapter 4):** The computational backbone of agentic search relies heavily on randomized algorithms:

- *Approximate nearest neighbor search:* Dense retrieval in RAG systems queries billion-scale vector databases using approximate nearest neighbor algorithms built on LSH, random projections, HNSW (which uses randomized graph construction), and product quantization. The retrieval quality-speed tradeoff is directly determined by the approximation parameters of these randomized data structures.
- *Bloom filters for deduplication:* Agentic search systems that retrieve from large corpora use Bloom filters to efficiently track which documents have already been retrieved, avoiding redundant processing.
- *Hashing for efficient embedding lookup:* Feature hashing and learned hash functions enable efficient lookup of embedding vectors in large-scale retrieval systems.
- *Random sampling for search diversification:* Search diversification strategies (ensuring retrieved documents cover diverse aspects of a query) use random sampling and randomized rounding algorithms to solve the underlying combinatorial optimization problem approximately.
- *Streaming algorithms for real-time indexing:* As document collections grow continuously, streaming algorithms from Section 5.6 enable real-time index updates without full re-indexing.
