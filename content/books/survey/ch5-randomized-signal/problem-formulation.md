---
sidebar_position: 2
title: "Problem Formulation"
---

# Problem Formulation

### Approximation Guarantees and the Power of Randomization

Many AI tasks can be formulated as optimization or estimation problems where exact solutions are computationally intractable. Randomized algorithms provide a powerful framework for trading a small, controlled amount of accuracy for dramatic reductions in computational cost. The formal framework is the (epsilon, delta)-approximation: with probability at least 1 - delta, the output is a multiplicative (1 + epsilon)-approximation of the optimal solution (the output never exceeds (1 + epsilon) times the optimal value, or stays above (1 - epsilon) times it for maximization problems).

The key insight, and the reason randomized algorithms are so effective, is that for many problems, achieving epsilon = 0.01 (a multiplicative tolerance of 1%, i.e. the answer is within a factor of 1.01 of optimal) requires **exponentially less** computation than achieving epsilon = 0 (exact solution) [@mitzenmacher2017probability, @motwani1995randomized]. A randomized algorithm that gives an answer within a factor of 1.01 of optimal in O(n log n) time is often far more useful than an exact algorithm that takes O(n^3) time, especially when the input itself is noisy (as training data always is). In many AI applications, the approximation error of randomized algorithms is smaller than the inherent noise in the data, making the approximation essentially lossless in practice.

### Concentration Inequalities: The Engine of Randomized Algorithms

The theoretical guarantees of randomized algorithms rest on **concentration inequalities**, mathematical results that bound the probability that a random variable deviates significantly from its expectation. Key concentration results include:

- **Chernoff-Hoeffding bounds:** For sums of independent bounded random variables, the probability of deviation epsilon from the mean decays exponentially as exp(-2 n epsilon^2) (for variables bounded in [0,1]). This underpins the guarantees of random sampling, reservoir sampling, and stochastic gradient descent.
- **Johnson-Lindenstrauss lemma:** Random projections preserve pairwise distances with high probability. This is the foundation of dimensionality reduction, random features, and efficient nearest neighbor search.
- **Matrix concentration (matrix Chernoff, matrix Bernstein):** Extensions of scalar concentration to random matrices, essential for analyzing randomized SVD, random feature approximations, and the spectral properties of random neural networks [@vershynin2018high, @tropp2015introduction].
- **Hanson-Wright inequality:** Bounds on quadratic forms in independent random variables, used in the analysis of random feature approximations and kernel methods.

These inequalities transform heuristic approximations into rigorous algorithms with provable guarantees, and understanding them is essential for designing and analyzing randomized methods for AI.

### Probabilistic Analysis of Neural Networks

Viewing neural networks through a probabilistic lens enables analysis techniques from random matrix theory, high-dimensional probability, and statistical learning theory. Key questions include:

- **Random initialization:** How do random weight matrices at initialization affect signal propagation, gradient flow, and learning dynamics? The eigenspectrum of random weight matrices (described by the Marchenko-Pastur law for i.i.d. entries, or by more refined results for structured random matrices) determines whether signals explode, vanish, or propagate stably through deep networks [@pennington2017nonlinear, @louart2018random].
- **Networks with random weights:** What is the expected behavior of randomly initialized networks before any training? Surprisingly, even untrained random networks have useful properties: they can separate linearly inseparable classes (with high probability), and their random features can approximate any continuous function (random Fourier features approximate shift-invariant kernels via Bochner's theorem, and the resulting kernel machines are universal approximators [@rahimi2007random]).
- **Randomized training procedures:** How do dropout, stochastic depth, data augmentation, and stochastic gradient descent improve generalization? Each of these introduces controlled randomness into training, and their effectiveness can be analyzed through the lens of regularization theory, Bayesian inference, and noise stability.

### Computational vs. Statistical Tradeoffs

A recurring theme in the intersection of randomized algorithms and AI is the **computational-statistical tradeoff** [@bottou2008tradeoffs]: for a fixed total budget of time or FLOPs, should one train a more complex model on less data, or a simpler model on more data? Randomized approximations shift this tradeoff by reducing the per-sample computational cost:

- Using random feature approximations for kernel methods enables processing substantially more data at the cost of a small approximation error. In the regime where the original kernel method is data-limited rather than approximation-limited, the statistical benefit of the extra data can outweigh the approximation loss, improving overall accuracy.
- Gradient sketching reduces communication cost in distributed training, enabling more workers and thus faster convergence (more gradient updates per unit time), despite the slightly noisier gradient estimates.
- Approximate attention (Performer, Reformer) enables processing much longer sequences. On tasks where the relevant signal spans contexts longer than exact attention can afford, the gain from the extended context window can qualitatively outweigh the accuracy lost to the attention approximation.

Understanding these tradeoffs (when approximation is acceptable, how much accuracy we sacrifice, and when the computational savings enable enough additional data or iterations to compensate) is critical for designing practical AI systems.
