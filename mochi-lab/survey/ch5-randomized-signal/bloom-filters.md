---
sidebar_position: 7
title: "Bloom Filters & Learned Indices"
---

# Bloom Filters & Learned Indices

The Bloom filter [@bloom1970space] is one of the most elegant probabilistic data structures: it uses k hash functions to map elements into a bit array, supporting set membership queries with zero false negatives and controllable false positive rates. Bloom filters are foundational in systems for AI, used in deduplication pipelines, caching, and distributed systems. The learning-augmented variant replaces some of the randomized structure with learned predictions.

### Learned Bloom Filters

Kriss et al. (2018) [@kriss2018adaptive] proposed replacing traditional Bloom filters with learned models that predict set membership. A learned Bloom filter trains a small neural network to predict whether an element is in the set, backed by a smaller traditional Bloom filter to handle false negatives. The learned model can exploit distributional properties of the data (e.g., URLs that look like spam) that traditional Bloom filters ignore, achieving lower false-positive rates at the same memory budget.

### Learned Index Structures

Kraska et al. (2018) [@kraska2018case] introduced the idea of replacing traditional index structures (B-trees, hash maps, Bloom filters) with learned models. The key insight is that an index is fundamentally a function from keys to positions, and neural networks are universal function approximators. A learned B-tree replacement (using a hierarchy of neural networks) can outperform traditional B-trees when the data distribution has learnable structure. This work inspired a rich line of research on learned data structures, including learned hash functions, learned sorting, and learned query optimization [@ferragina2020pgm].

### Applications in AI Systems

Learned data structures are increasingly used within AI systems themselves:
- Embedding table lookups in recommendation systems
- Approximate nearest neighbor indices for retrieval-augmented generation
- Data deduplication in pre-training pipelines using learned hash functions
- Routing decisions in Mixture-of-Experts models
