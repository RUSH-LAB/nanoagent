---
sidebar_position: 5
title: "Hashing for Machine Learning"
---

# Hashing for Machine Learning

### Locality-Sensitive Hashing (LSH)

Locality-Sensitive Hashing [@indyk1998approximate] is a family of randomized hash functions where similar items hash to the same bucket with high probability, while dissimilar items collide with low probability. Formally, a hash family H is (r, cr, p1, p2)-sensitive if for any two points x, y: if d(x,y) <= r then Pr[h(x) = h(y)] >= p1, and if d(x,y) >= cr then Pr[h(x) = h(y)] <= p2, where p1 > p2. The classic LSH for cosine similarity uses random hyperplane partitioning (SimHash [@charikar2002similarity]):

h(x) = sign(r^T x)

where r is a random vector. By using L independent hash tables, each with k hash functions concatenated, LSH enables sub-linear (approximately O(n^rho) where rho = log(1/p1) / log(1/p2) < 1) approximate nearest neighbor search [@andoni2006near]. The data-dependent LSH framework [@andoni2015optimal] achieves the theoretically optimal rho = 1/(2c^2 - 1) for Euclidean distance, substantially improving over data-independent schemes.

**HNSW (Hierarchical Navigable Small World)** graphs [@malkov2020hnsw] provide an alternative graph-based approach that often outperforms LSH in practice, using randomized graph construction for efficient approximate nearest neighbor search. HNSW builds a navigable small-world graph with hierarchical layers, where search proceeds by greedy traversal from coarse to fine layers. The construction is randomized (each element is assigned to layers probabilistically), and the resulting graph supports O(log n) expected search time with high recall. FAISS [@johnson2021faiss] provides GPU-accelerated implementations of both LSH and graph-based approaches for billion-scale vector search, with IVF-PQ (inverted file with product quantization) as the workhorse for large-scale deployments.

### SLIDE: Sub-Linear Deep Learning

Chen et al. (2020) [@chen2020slide] proposed SLIDE (Sub-LInear Deep learning Engine), which uses LSH to identify the most relevant neurons (those with highest activation) for each input, activating only a small subset of the network. For a fully-connected layer with d input dimensions and m output neurons, standard dense computation is O(dm); SLIDE identifies the top-k activated neurons in O(d * k) time using LSH, providing speedups proportional to the sparsity ratio m/k. SLIDE demonstrated that on CPUs, an LSH-accelerated deep network could outperform GPU-based dense training in wall-clock time for recommendation models with very large output layers (millions of categories). This work showed that randomized algorithms could fundamentally change the compute paradigm for neural networks. G-SLIDE [@chen2022gslide] later extended this to GPUs with LSH-based sparse computation.

### Learning-to-Hash

Rather than using predefined hash functions, learning-to-hash methods train neural networks to produce hash codes optimized for a specific retrieval task [@wang2018survey]. Deep hashing methods learn compact binary representations that preserve semantic similarity, enabling fast retrieval with Hamming distance computation (which is a single XOR + popcount instruction on modern CPUs). Representative methods include HashNet [@cao2017hashnet], which uses continuation methods to train binary hash codes end-to-end, and Deep Supervised Hashing [@liu2016deep], which uses pairwise labels for learning similarity-preserving hash codes. These methods bridge the gap between classical hashing (with theoretical guarantees) and learned representations (with task-specific optimization), achieving 10-100x speedups over brute-force search with minimal accuracy loss.

### Cross-Polytope Hashing

Andoni et al. (2015) [@andoni2015practical] introduced cross-polytope LSH, which hashes points to the nearest vertex of a randomly rotated cross-polytope (the high-dimensional analog of an octahedron). Cross-polytope LSH achieves asymptotically optimal rho values for cosine similarity and is more practically efficient than hyperplane LSH due to better collision probabilities per hash evaluation. The FALCONN library implements cross-polytope LSH with multi-probe extensions for practical high-dimensional nearest neighbor search.
