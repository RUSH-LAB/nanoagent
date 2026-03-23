---
sidebar_position: 12
title: "Probabilistic Data Structures in Systems for AI"
---

# Probabilistic Data Structures in Systems for AI

### HyperLogLog for Deduplication

HyperLogLog [@flajolet2007hyperloglog] estimates the cardinality (number of distinct elements) of a multiset using O(log log n) space per counter. In AI data pipelines, HyperLogLog is used to estimate dataset diversity, detect near-duplicate documents in pre-training corpora, and monitor vocabulary coverage during tokenizer training. The MinHash variant enables efficient estimation of Jaccard similarity between document sets, powering deduplication pipelines that process trillions of tokens [@lee2022deduplicating]. These probabilistic data structures are essential building blocks for the data curation pipelines that underpin modern LLM training, as discussed in Chapter 3 [@mitzenmacher2017probability].

### Reservoir Sampling for Data Selection

Vitter's reservoir sampling [@vitter1985random] maintains a uniform random sample of size k from a stream of unknown length. In AI systems, reservoir sampling is used for:

- Maintaining replay buffers in continual learning (see Chapter 1)
- Online data selection during pre-training
- Constructing evaluation sets from streaming data
- Fair sampling for bias evaluation

### Consistent Hashing for Distributed Training

Consistent hashing [@karger1997consistent] enables balanced distribution of data and computation across workers with minimal redistribution when workers are added or removed. In distributed AI training, consistent hashing is used for data parallelism, expert assignment in MoE models, and distributed embedding tables.
