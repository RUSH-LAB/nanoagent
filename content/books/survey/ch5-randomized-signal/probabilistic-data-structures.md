---
sidebar_position: 12
title: "Probabilistic Data Structures in Systems for AI"
---

# Probabilistic Data Structures in Systems for AI

### HyperLogLog for Deduplication

HyperLogLog [@flajolet2007hyperloglog] estimates the cardinality (number of distinct elements) of a multiset, with each register using O(log log n) bits. The algorithm works by hashing elements and observing the maximum number of leading zeros in the hash values (more leading zeros indicate more distinct elements), with the estimator using harmonic means across multiple registers for accuracy. In AI data pipelines, HyperLogLog is used to estimate dataset diversity, detect near-duplicate documents in pre-training corpora, and monitor vocabulary coverage during tokenizer training. The standard error is approximately 1.04 / sqrt(m) where m is the number of registers, so 2^14 registers (~12 KB of memory) achieve ~0.8% accuracy. The error is relative, so accuracy degrades for low cardinalities (under a few hundred distinct elements). The MinHash variant [@broder1997resemblance] enables efficient estimation of Jaccard similarity between document sets, powering deduplication pipelines that process trillions of tokens [@lee2022deduplicating]. The tradeoff HyperLogLog navigates is accuracy versus memory: register count m trades a sub-linear memory footprint against the 1.04 / sqrt(m) standard error, making it the right choice only when an exact count is unaffordable and a small relative error is tolerable. These probabilistic data structures are essential building blocks for the data curation pipelines that underpin modern LLM training [@mitzenmacher2017probability].

### Reservoir Sampling for Data Selection

Vitter's reservoir sampling [@vitter1985random] maintains a uniform random sample of size k from a stream of unknown length n, processing each element in O(1) time. The algorithm is beautifully simple. Keep the first k elements; for the i-th element (i > k), include it in the reservoir with probability k/i, replacing a random existing element. The proof of correctness follows from the invariant that after processing i elements, each has probability k/i of being in the reservoir. In AI systems, reservoir sampling is used for:

- Maintaining replay buffers in continual learning (see Chapter 1), where balanced Experience Replay (ER) [@chaudhry2019tiny] uses reservoir sampling to maintain representative examples from all previous tasks
- Online data selection during pre-training, enabling uniform sampling from data streams of unknown length
- Constructing evaluation sets from streaming data without storing the full stream
- Fair sampling for bias evaluation, ensuring all subgroups are proportionally represented

**Weighted reservoir sampling** [@efraimidis2006weighted] extends the basic algorithm to non-uniform sampling, enabling prioritized experience replay where important examples are sampled with higher probability. The tradeoff reservoir sampling navigates is sample uniformity versus per-element cost: it guarantees an unbiased sample over a stream of unknown length while spending only O(1) work per element, paying for this with single-pass sampling that cannot be revised once an element is evicted. The assumption of uniform or i.i.d. weights may break down when sample relevance is correlated with arrival order.

### Consistent Hashing for Distributed Training

Consistent hashing [@karger1997consistent] enables balanced distribution of data and computation across workers with minimal redistribution when workers are added or removed. When a worker joins or leaves, only O(1/n) of the keys need to be remapped, compared to O(n) for standard modular hashing. In distributed AI training, consistent hashing is used for data parallelism (assigning data shards to workers), expert assignment in MoE models (routing tokens to experts with balanced load), and distributed embedding tables (partitioning large embedding lookups across memory-constrained devices). Virtual nodes improve load balance further: assigning roughly O(log k) virtual nodes per physical worker tightens the distribution so each worker's share concentrates near the 1/k mean rather than fluctuating widely, since a single random placement leaves the busiest worker handling a max-load imbalance on the order of O(log N / log log N) above the average. However, good balance requires a sufficient number of virtual nodes, and with too few virtual nodes the load distribution can remain skewed. The tradeoff consistent hashing navigates is load balance versus routing-table and rebalancing overhead: virtual nodes buy smoother partitions at the cost of a larger ring to maintain and look up, while the O(1/n) key remapping on membership changes is precisely what makes it preferable to modular hashing when workers churn.
