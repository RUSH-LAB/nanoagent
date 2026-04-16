---
sidebar_position: 6
title: "Neural Architecture Search"
---

## Neural Architecture Search

Neural Architecture Search (NAS) automates the design of neural network architectures, replacing human intuition with systematic search over a defined design space. The premise is that human-designed architectures may be far from optimal, and algorithmic search can discover designs that exploit hardware-specific constraints and problem-specific structures that human engineers would not consider [@elsken2019neural].

### The NAS Problem

NAS formulates architecture design as an optimization problem: given a search space S of possible architectures, a performance metric P (e.g., accuracy on a validation set), and a cost constraint C (e.g., maximum FLOPs or latency), find the architecture A* = argmax_{A in S} P(A) subject to Cost(A) <= C. The challenge lies in the vast size of the search space (typically 10^{10} to 10^{30} possible architectures) and the expense of evaluating each candidate (training to convergence can take hours to days).

Early NAS methods used reinforcement learning to search: Zoph and Le (2017) [@zoph2017neural] trained an RNN controller to generate architecture descriptions, with the validation accuracy of the generated architecture serving as the reward signal. While effective, this approach required 800+ GPU-days -- training and evaluating thousands of candidate architectures. The prohibitive cost motivated the development of more efficient search strategies.

### DARTS: Differentiable Architecture Search

**DARTS** (Liu et al., 2019) [@liu2019darts] fundamentally changed NAS by relaxing the discrete architecture search space to be continuous, enabling gradient-based optimization. DARTS represents the architecture as a mixture of all possible operations (convolutions, pooling, skip connections) at each position, with continuous mixing weights (architecture parameters) that determine the contribution of each operation. The architecture parameters and model weights are jointly optimized using bilevel optimization: the weights are optimized on the training set (inner loop) and the architecture parameters are optimized on the validation set (outer loop).

After search, the final architecture is obtained by discretizing the continuous weights -- selecting the operation with the highest weight at each position. DARTS reduced the NAS cost from thousands of GPU-days to a single GPU-day, democratizing NAS research. However, DARTS suffers from instability and a tendency to collapse to skip connections, issues that subsequent work has addressed through regularization and improved search spaces [@chen2019progressive_darts, @zela2020understanding].

### EfficientNet and Compound Scaling

**EfficientNet** (Tan and Le, 2019) [@tan2019efficientnet] combined NAS with a principled scaling strategy. First, NAS is used to discover a base architecture (EfficientNet-B0) optimized for a small compute budget. Then, the model is scaled up using **compound scaling**, which uniformly scales width, depth, and resolution using a single compound coefficient phi:

depth: d = alpha^phi, width: w = beta^phi, resolution: r = gamma^phi

where alpha, beta, gamma are determined by a small grid search and phi controls the overall scale. The key insight is that scaling all three dimensions together (rather than scaling one dimension in isolation, as was common practice) produces better accuracy-efficiency tradeoffs. EfficientNet-B7 achieved state-of-the-art ImageNet accuracy (84.3%) while being 8.4x smaller and 6.1x faster than the best existing models, demonstrating the power of principled scaling combined with NAS.

### Once-for-All (OFA) Networks

**Once-for-All** (Cai et al., 2020) [@cai2020onceforall] addressed a critical limitation of standard NAS: each search targets a single hardware platform, and searching for a new platform requires a new search. OFA trains a single large "supernet" that supports many sub-networks of different sizes (varying depth, width, kernel size, and resolution). The supernet is trained using progressive shrinking, which gradually enables smaller sub-networks during training. At deployment time, a sub-network appropriate for the target hardware constraints is selected without retraining, using an evolutionary search over the sub-network space with hardware-specific latency as a constraint.

OFA amortizes the training cost across all deployment targets: a single training run (which is expensive but done only once) produces models optimized for dozens of different hardware platforms, from high-end GPUs to mobile phones. This is particularly valuable for deploying AI across diverse edge devices.

### Hardware-Aware NAS

Modern NAS increasingly incorporates hardware constraints directly into the search objective, optimizing not just for accuracy but for deployment-relevant metrics like latency, energy consumption, or throughput on specific target devices [@benmeziane2021comprehensive, @li2022neural].

**MnasNet** (Tan et al., 2019) [@tan2019mnasnet] pioneered hardware-aware NAS by using real on-device latency as a search objective, rather than proxy metrics like FLOPs. This is important because the relationship between FLOPs and latency is non-trivial: operations with the same FLOP count can have very different latencies depending on memory access patterns, parallelizability, and hardware-specific optimizations. MnasNet's direct latency optimization produced architectures specifically tailored for mobile deployment.

**MobileNet v3** (Howard et al., 2019) [@howard2019searching] combined hardware-aware NAS with manual architecture refinements, using NAS to optimize the core building blocks and human expertise to design the overall architecture structure. The resulting models set new efficiency benchmarks for mobile computer vision.

### NAS for Transformers and LLMs

As Transformers have become the dominant architecture, NAS has been applied to optimize their design:

**AutoFormer** (Chen et al., 2022) [@chen2022autoformer_nas] searches over Transformer-specific dimensions (embedding size, number of heads, FFN ratio, depth) using a one-shot supernet approach. By searching within the Transformer design space rather than over arbitrary operations, AutoFormer can efficiently discover Transformer variants optimized for different compute budgets.

The LLM era has shifted NAS from discovering new architectures to **optimizing hyperparameters within established architectures** -- finding the optimal depth, width, number of heads, FFN ratio, and attention pattern for a given compute budget. This "architecture engineering" approach uses scaling laws and grid search rather than classical NAS algorithms, but addresses the same fundamental question: what is the most efficient architecture for a given constraint?

### Limitations of NAS

Despite its promise, NAS faces several challenges: (1) the search space design is itself a manual process that requires significant expertise, and the optimal search space may vary across tasks and hardware; (2) the ranking correlation between proxy metrics (used during search) and final performance (after full training) is often imperfect, leading to suboptimal architecture selection; (3) NAS has been less successful for large-scale models, where the cost of training even a single candidate can be millions of dollars; and (4) the architectures discovered by NAS are often difficult to interpret, providing limited insight into why they work well.
