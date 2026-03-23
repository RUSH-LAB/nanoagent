---
sidebar_position: 6
title: "Sketching & Streaming"
---

# Sketching & Streaming

Sketching algorithms maintain compact, lossy summaries of data that support approximate query answering. In the streaming model, data arrives one element at a time and the algorithm must process it in a single pass with memory much smaller than the data size. These algorithms are directly relevant to AI systems that must process massive datasets (pre-training data), operate in online settings (continual learning), or compress communication (distributed training).

### Count-Min Sketch and CountSketch

The Count-Min Sketch (Cormode and Muthukrishnan, 2005) [@cormode2005improved] and CountSketch (Charikar et al., 2004) [@charikar2004finding] are streaming data structures that maintain approximate frequency counts in sub-linear space. A Count-Min Sketch uses d hash functions and a d x w array of counters; to insert an element, it increments d counters (one per hash function). To query, it returns the minimum of the d counter values, which overestimates the true frequency by at most epsilon * ||f||_1 with probability at least 1 - delta, using O((1/epsilon) * log(1/delta)) space. CountSketch uses signed hash functions to achieve unbiased estimates with tighter concentration.

These have been adapted for machine learning in several ways:

- **Gradient compression:** Ivkin et al. (2019) [@ivkin2019communication] used Count-Min Sketch for compressing gradients in distributed training, transmitting only a sketch instead of the full gradient vector. This reduces communication cost from O(d) to O(k * log(d/k)) per worker per iteration, enabling efficient distributed training of models with billions of parameters.
- **Feature hashing:** Weinberger et al. (2009) [@weinberger2009feature] used hashing to reduce feature dimensionality while preserving inner products, a technique widely used in large-scale linear models and recommendation systems. Feature hashing maps high-dimensional sparse features to a lower-dimensional space using a hash function, avoiding the need to maintain an explicit feature dictionary.

### CountSketch for Gradient Compression

Spring and Shrivastava (2019) [@spring2019compressing] applied CountSketch to compress gradient updates in deep learning training. By sketching the gradient vector into a much smaller data structure, communicating the sketch, and recovering an approximate gradient through the median estimator, they achieved order-of-magnitude communication reduction with minimal impact on convergence. The key insight is that gradient vectors are typically approximately sparse -- a small fraction of entries carry most of the magnitude -- making them amenable to sketching. For a gradient vector of dimension d, a CountSketch of size O(k log d) captures the top-k entries with high probability, and these top-k entries typically account for over 90% of the gradient's energy.

### Streaming PCA and Frequent Directions

Streaming PCA algorithms maintain a low-rank approximation of a data matrix seen one row at a time, without storing the full matrix. Oja's algorithm [@oja1982simplified] provides the simplest approach: maintain a single vector that is updated toward the top eigenvector using a stochastic power method. Extending to the top-k eigenvectors, block power iteration processes data in a single pass, maintaining a k-dimensional subspace approximation.

Liberty (2013) [@liberty2013simple] proposed Frequent Directions, a deterministic streaming algorithm for matrix sketching that maintains a small l x d matrix B such that for any unit vector x, ||Ax||^2 - ||Bx||^2 >= 0 and ||Ax||^2 - ||Bx||^2 <= 2||A||_F^2 / l. Frequent Directions processes each row in O(ld) time and uses O(ld) space -- independent of the number of rows. This makes it suitable for online learning settings where data arrives continuously and batch PCA is infeasible. In the context of continual learning, Frequent Directions can maintain an evolving low-rank representation of the data seen so far, enabling methods like GPM [@saha2021gradient] to track the representation subspace without storing all previous data.

### Reservoir Sampling

Reservoir sampling [@vitter1985random] maintains a uniform random sample of fixed size k from a stream of unknown length n. Vitter's algorithm processes each element in O(1) amortized time: for the i-th element (i > k), it replaces a random element in the reservoir with probability k/i. After processing n elements, each element has exactly probability k/n of being in the sample -- regardless of when it arrived. The proof of correctness is elegant: by induction, after processing i elements, each element is in the reservoir with probability k/i. When the (i+1)-th element arrives, it enters the reservoir with probability k/(i+1), and each existing element stays with probability 1 - (k/(i+1)) * (1/k) = i/(i+1), giving a final probability of (k/i) * (i/(i+1)) = k/(i+1), maintaining the invariant.

In AI systems, reservoir sampling serves several critical functions:
- **Replay buffers in continual learning:** Maintaining a representative sample of all data seen so far for experience replay, ensuring that the replay buffer does not become biased toward recent tasks (Chapter 1). ER (Experience Replay) [@chaudhry2019tiny] uses reservoir sampling as its buffer management strategy, and the theoretical guarantee of uniform sampling is what ensures that the replay distribution approximates the true data distribution.
- **Data selection during pre-training:** Sampling representative subsets of massive pre-training corpora for monitoring training progress and constructing evaluation sets. When training on trillion-token corpora, reservoir sampling enables maintaining a fixed-size evaluation set that is representative of all data seen so far, without knowing the total corpus size in advance.
- **Online evaluation:** Maintaining a running evaluation set from streaming data without storing the full data stream.
- **Fair sampling:** Ensuring that evaluation and training samples are representative of the full data distribution, even when the distribution shifts over time.
- **Weighted reservoir sampling:** Efraimidis and Spirakis (2006) [@efraimidis2006weighted] extended reservoir sampling to weighted streams, where each element has a priority weight and the reservoir maintains a weighted random sample. This is useful in AI for importance-weighted replay, where some examples are more informative than others and should be replayed more frequently.

### Applications to Distributed Training

The sketching and streaming algorithms described above find their most impactful application in distributed deep learning training, where communication between workers is often the primary bottleneck. For a model with d parameters and N workers, naive synchronous SGD requires communicating N * d floats per iteration -- for a model like GPT-3 with 175 billion parameters and hundreds of workers, this amounts to terabytes of communication per iteration.

Gradient sketching addresses this by compressing each gradient to a sketch of size O(k * log(d/k)), where k is the number of significant gradient entries. The key insight is that gradients are approximately sparse: in practice, the top 1% of gradient entries typically account for 99% of the gradient's L2 norm. By sketching the gradient, identifying the top-k entries from the sketch, and communicating only these entries (with their positions), communication is reduced by 100-1000x with minimal impact on convergence.

This approach has been scaled to production training systems. DeepSpeed's 1-bit Adam and 0/1 Adam use communication compression techniques inspired by sketching to reduce gradient communication by 5x while maintaining convergence speed. DALL-E's training used gradient checkpointing and communication compression to train a 12-billion parameter model across hundreds of GPUs. The theoretical foundation for these methods -- that sketched stochastic gradients converge at the same rate as exact stochastic gradients when the sketch size is sufficient -- connects directly to the concentration inequalities and sketching guarantees from Section 5.2.
