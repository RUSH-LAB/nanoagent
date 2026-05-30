---
sidebar_position: 14
title: "Open Problems & Future Directions"
---

# Open Problems & Future Directions

### Tighter Bounds and Optimal Algorithms

While many randomized algorithms have known approximation guarantees, gaps remain between upper and lower bounds. For example, the optimal number of random features needed for epsilon-accurate kernel approximation in the worst case is still debated: current upper bounds are O(epsilon^{-2}) but data-dependent bounds suggest that much fewer features may suffice for structured data [@rahimi2009weighted, @bach2017equivalence]. Bach (2017) showed that for data concentrated on a low-dimensional manifold, the number of features needed scales with the intrinsic dimensionality rather than the ambient dimensionality, but the precise relationship between data geometry and optimal feature count remains open. Similarly, the optimal tradeoff between sketch size and approximation quality for gradient compression is not fully characterized: current practical systems use heuristic sketch sizes that are likely far from optimal for typical gradient distributions. Developing optimal algorithms with matching lower bounds would provide definitive guidance for practitioners: how many random features, hash functions, or sketch dimensions are truly needed?

### Co-Design of Algorithms and Hardware for Sparse and Randomized Computation

Randomized algorithms often have irregular memory access patterns: hash table lookups involve random memory reads, sparse matrix operations have irregular access patterns, and random projections require accessing random subsets of the weight matrix. Modern GPUs are optimized for regular, dense computation with coalesced memory access, making these irregular patterns inefficient. This mismatch between algorithmic efficiency (fewer operations) and hardware efficiency (irregular access patterns are slow) limits the practical speedup of randomized methods.

Co-designing randomized algorithms with hardware (or designing hardware that efficiently supports randomized computation) is an important direction. SLIDE's success on CPUs [@chen2020slide] (where irregular memory access is less penalized than on GPUs) hints that the hardware landscape may need to shift. Emerging architectures with large on-chip memory (like Cerebras and Graphcore) may be better suited to the memory access patterns of randomized algorithms.

### Adaptive and Data-Dependent Randomization

Most randomized methods use **data-independent** randomization: the random projections, hash functions, or sketches are drawn before seeing any data. Data-dependent randomization, which adapts the random maps to the data distribution, can significantly improve approximation quality:

- **Learning-to-hash** methods train hash functions on data, achieving much better collision probabilities for actual query distributions than universal LSH families. The challenge is maintaining worst-case guarantees while optimizing for average-case performance.
- **Data-dependent random features** choose the frequency distribution of random Fourier features based on the data, rather than using the kernel's spectral density. Sampling features from a leverage-score distribution rather than the kernel's spectral density reduces the required feature count to scale with the effective dimension of the data rather than the ambient dimension [@bach2017equivalence], so the magnitude of improvement depends on the data's intrinsic geometry.
- **Adaptive sketching** methods adjust the sketch structure based on observed data properties (e.g., detecting and adapting to heavy hitters in a stream).

The general principle of "learned randomization" (using machine learning to optimize the random components of randomized algorithms) is a frontier direction that could yield substantial practical improvements.

### Theoretical Foundations of Deep Learning Through Random Matrix Theory

Random matrix theory (RMT) provides some of the most powerful tools for understanding neural networks, but many fundamental questions remain open:

- **Generalization from random matrix spectra:** The eigenvalue distribution of weight matrices, gradient matrices, and feature covariance matrices during training reveals information about generalization, but the precise relationship between spectral properties and generalization error is not fully understood [@pennington2017nonlinear, @louart2018random]. Can we predict generalization from the eigenspectrum alone?
- **Implicit regularization of SGD:** Stochastic gradient descent introduces noise that has been shown to have implicit regularization effects (biasing toward flatter minima, simpler solutions). RMT provides tools for analyzing this noise, but a complete theory of SGD's implicit regularization through the RMT lens is still developing.
- **Random matrix theory for Transformers:** The attention matrix (softmax(QK^T/sqrt(d))) in Transformers is a random matrix when the input is random, and its spectral properties determine information flow. Analyzing how the spectrum evolves during training could provide insights into attention pattern formation and the role of attention heads.
- **Architecture design from RMT:** Can random matrix theory guide the design of neural network architectures? The depth-width tradeoff, the choice of activation function, and the initialization scheme all have RMT-analyzable consequences. A theory that prescribes optimal architecture choices from RMT principles would be transformative.

### Integration with Foundation Models at Scale

As foundation models grow to hundreds of billions or trillions of parameters, randomized algorithms become increasingly critical for their training, serving, and adaptation. Key challenges include:

- **End-to-end guarantees:** When multiple randomized approximations are composed (randomized attention + gradient sketching + quantized weights + approximate KV-cache), how do the errors compound? Standard error analysis provides worst-case bounds through the triangle inequality, but these bounds are typically far too conservative: in practice, errors from different approximations often partially cancel rather than compounding. Developing tighter end-to-end quality guarantees for systems with multiple layers of approximation is a systems-level challenge that current theory does not adequately address. A model served with 4-bit quantization, KV-cache eviction, and speculative decoding involves three independent sources of approximation error, yet no existing framework can precisely characterize their joint impact on generation quality.
- **Randomized algorithms for training dynamics:** Understanding how randomized training procedures (mini-batch SGD [@robbins1951stochastic], dropout [@srivastava2014dropout], data augmentation) interact with model scale. Do the benefits of these techniques change qualitatively at the scale of frontier models? Empirical evidence suggests that dropout, for example, is less effective at very large scale (most frontier LLMs do not use dropout), raising the question of whether the implicit regularization of SGD with large batch training provides sufficient regularization on its own, or whether new forms of randomized regularization are needed.
- **Randomized methods for inference optimization:** Sketching and hashing techniques for efficient KV-cache management, attention computation, and expert routing in MoE models at serving time. The latency requirements of interactive serving create new constraints on randomized methods (the variance of approximation affects tail latency, not just average quality). A method with 1% mean quality loss but high variance may produce unacceptable responses at a nontrivial rate (for example, 5% of the time), making variance control as important as bias control for deployed systems.

### Spectral Theory of Large Language Models

Extending the spectral analysis of neural networks to the LLM regime raises new questions:

- What is the spectral structure of attention patterns in trained LLMs? How do different attention heads specialize in frequency/scale?
- Can the Fourier analysis of token embeddings reveal structure in the learned representation space?
- Does the spectral bias (learning low frequencies first) hold for language modeling, and if so, what does it mean for the acquisition of different linguistic capabilities (syntax vs. semantics vs. pragmatics)?
- Can spectral analysis guide the design of better positional encodings and attention mechanisms?

The central challenge is that spectral tools developed for fixed random matrices (where eigenvalue distributions converge under well-characterized regimes) often break down when applied to trained, data-dependent attention matrices whose spectral properties evolve during optimization.
