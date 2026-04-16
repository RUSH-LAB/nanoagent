---
sidebar_position: 12
title: "Probabilistic Data Structures in Systems for AI"
---

# Probabilistic Data Structures in Systems for AI

### HyperLogLog for Deduplication

HyperLogLog [@flajolet2007hyperloglog] estimates the cardinality (number of distinct elements) of a multiset using O(log log n) space per counter. The algorithm works by hashing elements and observing the maximum number of leading zeros in the hash values -- more leading zeros indicate more distinct elements, with the estimator using harmonic means across multiple registers for accuracy. In AI data pipelines, HyperLogLog is used to estimate dataset diversity, detect near-duplicate documents in pre-training corpora, and monitor vocabulary coverage during tokenizer training. The standard error is approximately 1.04 / sqrt(m) where m is the number of registers, so 2^14 registers (16 KB of memory) achieve ~0.8% accuracy. The MinHash variant [@broder1997resemblance] enables efficient estimation of Jaccard similarity between document sets, powering deduplication pipelines that process trillions of tokens [@lee2022deduplicating]. These probabilistic data structures are essential building blocks for the data curation pipelines that underpin modern LLM training [@mitzenmacher2017probability].

### Reservoir Sampling for Data Selection

Vitter's reservoir sampling [@vitter1985random] maintains a uniform random sample of size k from a stream of unknown length n, processing each element in O(1) time. The algorithm is beautifully simple: keep the first k elements; for the i-th element (i > k), include it in the reservoir with probability k/i, replacing a random existing element. The proof of correctness follows from the invariant that after processing i elements, each has probability k/i of being in the reservoir. In AI systems, reservoir sampling is used for:

- Maintaining replay buffers in continual learning (see Chapter 1), where balanced Experience Replay (ER) [@chaudhry2019tiny] uses reservoir sampling to maintain representative examples from all previous tasks
- Online data selection during pre-training, enabling uniform sampling from data streams of unknown length
- Constructing evaluation sets from streaming data without storing the full stream
- Fair sampling for bias evaluation, ensuring all subgroups are proportionally represented

**Weighted reservoir sampling** [@efraimidis2006weighted] extends the basic algorithm to non-uniform sampling, enabling prioritized experience replay where important examples are sampled with higher probability.

### Consistent Hashing for Distributed Training

Consistent hashing [@karger1997consistent] enables balanced distribution of data and computation across workers with minimal redistribution when workers are added or removed. When a worker joins or leaves, only O(1/n) of the keys need to be remapped, compared to O(n) for standard modular hashing. In distributed AI training, consistent hashing is used for data parallelism (assigning data shards to workers), expert assignment in MoE models (routing tokens to experts with balanced load), and distributed embedding tables (partitioning large embedding lookups across memory-constrained devices). Virtual nodes improve load balance further, reducing variance in partition sizes from O(n/k) to O(n/k * log k) for k workers.
