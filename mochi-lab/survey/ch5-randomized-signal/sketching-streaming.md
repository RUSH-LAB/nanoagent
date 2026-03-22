---
sidebar_position: 6
title: "Sketching & Streaming"
---

# Sketching & Streaming

### Count-Min Sketch and CountSketch

The Count-Min Sketch (Cormode and Muthukrishnan, 2005) [@cormode2005improved] and CountSketch (Charikar et al., 2004) [@charikar2004finding] are streaming data structures that maintain approximate frequency counts in sub-linear space. These have been adapted for machine learning:

- **Gradient compression:** Ivkin et al. (2019) [@ivkin2019communication] used Count-Min Sketch for compressing gradients in distributed training, transmitting only a sketch instead of the full gradient vector. This reduces communication cost from O(d) to O(k * log(d/k)) per worker.
- **Feature hashing:** Weinberger et al. (2009) [@weinberger2009feature] used hashing to reduce feature dimensionality while preserving inner products, a technique widely used in large-scale linear models.

### CountSketch for Gradient Compression

Spring and Shrivastava (2019) [@spring2019compressing] applied CountSketch to compress gradient updates in deep learning training. By sketching the gradient vector into a much smaller data structure, communicating the sketch, and recovering an approximate gradient, they achieved order-of-magnitude communication reduction with minimal impact on convergence. The key insight is that gradient vectors are typically approximately sparse -- a few entries carry most of the magnitude -- making them amenable to sketching.

### Streaming PCA and Frequent Directions

Streaming PCA algorithms maintain a low-rank approximation of a data matrix seen one row at a time [@oja1982simplified]. Liberty (2013) [@liberty2013simple] proposed Frequent Directions, a deterministic streaming algorithm for matrix sketching that maintains a small matrix B such that A^T A - B^T B is approximately zero (in the spectral norm sense). Frequent Directions is used in online learning settings where data arrives continuously and batch PCA is infeasible.

### Reservoir Sampling

Reservoir sampling [@vitter1985random] maintains a uniform random sample of fixed size k from a stream of unknown length. In AI systems, reservoir sampling is used for: data selection in continual learning (maintaining a representative buffer), deduplication pipelines for pre-training data, and online evaluation with fixed memory.
