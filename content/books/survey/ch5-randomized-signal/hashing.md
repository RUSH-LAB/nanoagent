---
sidebar_position: 5
title: "Hashing for Machine Learning"
---

# Hashing for Machine Learning

### Locality-Sensitive Hashing (LSH)

Locality-Sensitive Hashing [@indyk1998approximate] is a family of randomized hash functions where similar items hash to the same bucket with high probability, while dissimilar items collide with low probability. Formally, a hash family H is (r, cr, p1, p2)-sensitive if for any two points x, y: if d(x,y) <= r then Pr[h(x) = h(y)] >= p1, and if d(x,y) >= cr then Pr[h(x) = h(y)] <= p2, where p1 > p2. The classic LSH for cosine similarity uses random hyperplane partitioning (SimHash [@charikar2002similarity]):

h(x) = sign(r^T x)

where r is a random vector. By using L independent hash tables, each with k hash functions concatenated, LSH enables sub-linear (approximately O(n^rho) where rho = log(1/p1) / log(1/p2) < 1) approximate nearest neighbor search [@andoni2006near]. The data-dependent LSH framework [@andoni2015optimal] achieves the theoretically optimal rho = 1/(2c^2 - 1) for Euclidean distance, substantially improving over data-independent schemes.

**HNSW (Hierarchical Navigable Small World)** graphs [@malkov2020hnsw] provide an alternative graph-based approach that uses randomized graph construction for efficient approximate nearest neighbor search. On standard recall/latency benchmarks (the ann-benchmarks suite), graph methods such as HNSW dominate LSH across most high-recall operating points, delivering substantially higher query throughput at a fixed recall@k on common million-scale datasets. LSH remains competitive mainly where its theoretical guarantees, streaming/insertion behavior, or lower index-build cost and memory footprint matter, since HNSW's advantage comes at the price of a more expensive build and a larger in-memory graph. HNSW builds a navigable small-world graph with hierarchical layers, where search proceeds by greedy traversal from coarse to fine layers. The construction is randomized (each element is assigned to layers probabilistically), and the resulting graph supports O(log n) expected search time with high recall. FAISS [@johnson2021faiss] provides GPU-accelerated implementations of both LSH and graph-based approaches for billion-scale vector search, with IVF-PQ (inverted file with product quantization) as the workhorse for large-scale deployments.

### SLIDE: Sub-Linear Deep Learning

Chen et al. (2020) [@chen2020slide] proposed SLIDE (Sub-LInear Deep learning Engine), which uses LSH to identify the most relevant neurons (those with highest activation) for each input, activating only a small subset of the network. For a fully-connected layer with d input dimensions and m output neurons, standard dense computation is O(dm); SLIDE identifies the top-k activated neurons in O(d * k) time using LSH, providing speedups proportional to the sparsity ratio m/k. SLIDE demonstrated that on CPUs, an LSH-accelerated deep network could outperform GPU-based dense training in wall-clock time for recommendation models with very large output layers (millions of categories). This result is specific to extreme-classification settings with very large output layers, where the dense matrix multiply dominates cost, and does not imply that CPU training beats GPU training in general. The approach also carries practical costs that the original work highlights: maintaining LSH tables for every layer inflates the main-memory footprint, and the sparse, randomized neuron-access pattern can thrash CPU caches, so realized gains depend on tuning hash parameters and on the hardware's memory hierarchy. G-SLIDE [@chen2022gslide] later extended this to GPUs with LSH-based sparse computation.

### Learning-to-Hash

Rather than using predefined hash functions, learning-to-hash methods train neural networks to produce hash codes optimized for a specific retrieval task [@wang2018survey]. Deep hashing methods learn compact binary representations that preserve semantic similarity, enabling fast retrieval with Hamming distance computation (which is a single XOR + popcount instruction on modern CPUs). Representative methods include HashNet [@cao2017hashnet], which uses continuation methods to train binary hash codes end-to-end, and Deep Supervised Hashing [@liu2016deep], which uses pairwise labels for learning similarity-preserving hash codes. These methods bridge the gap between classical hashing (with theoretical guarantees) and learned representations (with task-specific optimization). The speedup over brute-force search is regime-dependent: it grows with database size and shrinks as the code length and the recall@k target increase, since longer codes and tighter recall budgets force more candidate comparisons. The accuracy/efficiency trade-off is therefore best reported at a specific operating point (a stated bit length and recall@k on a named dataset) rather than as a single headline figure.

### Cross-Polytope Hashing

Andoni et al. (2015) [@andoni2015practical] introduced cross-polytope LSH, which hashes points to the nearest vertex of a randomly rotated cross-polytope (the high-dimensional analog of an octahedron). Cross-polytope LSH achieves asymptotically optimal rho values for cosine similarity and is more practically efficient than hyperplane LSH due to better collision probabilities per hash evaluation. The FALCONN library implements cross-polytope LSH with multi-probe extensions for practical high-dimensional nearest neighbor search.
