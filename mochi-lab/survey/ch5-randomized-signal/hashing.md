---
sidebar_position: 5
title: "Hashing for Machine Learning"
---

# Hashing for Machine Learning

### Locality-Sensitive Hashing (LSH)

Locality-Sensitive Hashing [@indyk1998approximate] is a family of randomized hash functions where similar items hash to the same bucket with high probability, while dissimilar items collide with low probability. The classic LSH for cosine similarity uses random hyperplane partitioning (SimHash):

h(x) = sign(r^T x)

where r is a random vector. By using multiple independent hash functions and hash tables, LSH enables sub-linear (approximately O(n^rho) where rho < 1) approximate nearest neighbor search [@andoni2006near]. HNSW (Hierarchical Navigable Small World) graphs [@malkov2020hnsw] provide an alternative graph-based approach that often outperforms LSH in practice, using randomized graph construction for efficient approximate nearest neighbor search. FAISS [@johnson2021faiss] provides GPU-accelerated implementations of both approaches for billion-scale vector search.

### SLIDE: Sub-Linear Deep Learning

Chen et al. (2020) [@chen2020slide] proposed SLIDE (Sub-LInear Deep learning Engine), which uses LSH to identify the most relevant neurons (those with highest activation) for each input, activating only a small subset of the network. SLIDE demonstrated that on CPUs, an LSH-accelerated deep network could outperform GPU-based dense training in wall-clock time. This work showed that randomized algorithms could fundamentally change the compute paradigm for neural networks. G-SLIDE [@chen2022gslide] later extended this to GPUs with LSH-based sparse computation.

### Learning-to-Hash

Rather than using predefined hash functions, learning-to-hash methods train neural networks to produce hash codes optimized for a specific retrieval task [@wang2018survey]. Deep hashing methods learn compact binary representations that preserve semantic similarity, enabling fast retrieval with Hamming distance computation. These methods bridge the gap between classical hashing (with theoretical guarantees) and learned representations (with task-specific optimization).

### Cross-Polytope Hashing

Andoni et al. (2015) [@andoni2015practical] introduced cross-polytope LSH, which hashes points to the nearest vertex of a randomly rotated cross-polytope (the high-dimensional analog of an octahedron). Cross-polytope LSH achieves asymptotically optimal rho values for cosine similarity and is more practically efficient than hyperplane LSH due to better collision probabilities.
