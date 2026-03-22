---
sidebar_position: 14
title: "Open Problems & Future Directions"
---

# Open Problems & Future Directions

### Tighter Bounds and Optimal Algorithms

While many randomized algorithms have known approximation guarantees, gaps remain between upper and lower bounds. For example, the optimal number of random features needed for epsilon-accurate kernel approximation in the worst case is still debated [@rahimi2009weighted]. Developing optimal algorithms with matching lower bounds would provide definitive guidance for practitioners.

### Co-Design of Algorithms and Hardware

Randomized algorithms often have irregular memory access patterns (hash table lookups, random projections) that are poorly suited to GPUs optimized for regular, dense computation. Co-designing randomized algorithms with hardware -- or designing hardware that efficiently supports randomized computation -- is an important direction. SLIDE's CPU success [@chen2020slide] hints that the hardware landscape may shift toward supporting sparse, irregular computation.

### Adaptive Randomization

Most randomized methods use data-independent randomization (e.g., random projections drawn once before seeing the data). Data-dependent randomization -- adapting the random maps to the data distribution -- can significantly improve approximation quality. Learning-to-hash is one instance, but the general principle of "learned randomization" is underexplored.

### Theoretical Foundations of Deep Learning Through Random Matrix Theory

Random matrix theory provides tools for analyzing neural networks at initialization, during training, and at convergence [@pennington2017nonlinear, @louart2018random]. Key open questions include: What do the eigenvalue distributions of weight matrices reveal about generalization? How do random initializations interact with optimization landscape geometry? Can random matrix theory guide architecture design?

### Integration with Foundation Models

As foundation models grow, randomized algorithms become increasingly critical for their training, serving, and adaptation. Understanding how to combine randomized methods (sketching, hashing, random projections, approximate attention) into coherent systems that maintain end-to-end quality guarantees is a systems-level challenge.
