---
sidebar_position: 7
title: "Bloom Filters & Learned Indices"
---

# Bloom Filters & Learned Indices

The Bloom filter [@bloom1970space] is one of the most elegant probabilistic data structures: it uses k hash functions to map elements into a bit array of m bits, supporting set membership queries with zero false negatives and a controllable false positive rate of approximately (1 - e^{-kn/m})^k, where n is the number of inserted elements. For optimal k = (m/n) ln 2, the false positive rate is (1/2)^k, which decreases exponentially with bits per element. This remarkable space-accuracy tradeoff -- answering "is x in S?" using only ~10 bits per element for a 1% false positive rate, compared to storing full elements which may require hundreds of bytes -- makes Bloom filters foundational in systems for AI, used in deduplication pipelines for LLM pre-training data [@lee2022deduplicating], caching layers in retrieval systems, and distributed training coordination.

### Counting and Deletable Bloom Filters

Standard Bloom filters do not support element deletion (clearing a bit might affect other elements that hash to the same position). Counting Bloom filters replace each bit with a counter, supporting both insertion and deletion at the cost of increased memory. Cuckoo filters [@fan2014cuckoo] provide an alternative that supports deletion while using less memory than counting Bloom filters and achieving lower false positive rates. In AI systems, deletable Bloom filters are useful for maintaining dynamic data indices -- for example, tracking which documents have been processed in a continual learning pipeline where documents may be retracted or updated.

### Learned Bloom Filters

Kriss et al. (2018) [@kriss2018adaptive] proposed replacing traditional Bloom filters with learned models that predict set membership. A learned Bloom filter trains a small neural network to predict whether an element is in the set, backed by a smaller traditional Bloom filter to handle false negatives. The learned model can exploit distributional properties of the data (e.g., URLs that look like spam, email addresses from known domains) that traditional Bloom filters ignore, achieving 10-70% lower false-positive rates at the same memory budget. The key insight is that when the data has learnable structure, a model can use far fewer bits per element than a data-oblivious hash function.

### Learned Index Structures

Kraska et al. (2018) [@kraska2018case] introduced the idea of replacing traditional index structures (B-trees, hash maps, Bloom filters) with learned models. The key insight is that an index is fundamentally a function from keys to positions, and neural networks are universal function approximators. A learned B-tree replacement (using a hierarchy of neural networks) can outperform traditional B-trees when the data distribution has learnable structure -- for example, if keys are approximately uniformly distributed, a simple linear model can serve as an index with O(1) lookup time. This work inspired a rich line of research on learned data structures, including the PGM-index [@ferragina2020pgm] (which uses piecewise linear models for optimal space-time tradeoffs), learned hash functions, learned sorting, and learned query optimization.

### Applications in AI Systems

Bloom filters and learned data structures are increasingly used within AI systems:

- **Deduplication in pre-training:** MinHash and Bloom filters are used to detect near-duplicate documents in trillion-token pre-training corpora [@lee2022deduplicating, @mitzenmacher2017probability]. Given the scale of modern pre-training data (trillions of tokens from web crawls), exact deduplication is infeasible, and probabilistic methods provide the only practical approach.
- **Embedding table lookups:** In recommendation systems with billions of items, learned hash functions map item IDs to embedding table indices more efficiently than random hashing, reducing collision rates and improving model quality.
- **Approximate nearest neighbor indices:** ANN indices like FAISS [@johnson2021faiss] and HNSW [@malkov2020hnsw] use probabilistic data structures internally for efficient candidate generation and filtering during similarity search.
- **Data selection in training:** Bloom filters track which training examples have been seen in online learning settings, enabling curriculum learning and sampling strategies without storing the full dataset.
- **Routing in MoE models:** Expert routing decisions in Mixture-of-Experts models can be viewed as learned hash functions that map inputs to experts, connecting the learned data structures literature to efficient architecture design.
