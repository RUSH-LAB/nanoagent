---
title: Mathematics for Machine Learning
sidebar_position: 0
---

# Mathematics for Machine Learning

Modern machine learning rests on four mathematical pillars: **linear algebra** (the language of data and transformations), **calculus and optimization** (the engine that finds optimal parameters), **probability and statistics** (the framework for reasoning under uncertainty), and **information theory** (the measure of what models learn). This textbook develops each pillar from first principles, with every concept motivated by and connected to its role in machine learning.

## How This Textbook Is Organized

We begin with computational foundations (what can be computed, and how hardware computes it) because understanding the machine constrains and informs every algorithmic choice. We then introduce the core abstractions of machine learning (loss functions, gradient descent, backpropagation) before building the mathematical machinery in depth.

## Chapters

- **[Introduction to Computing](intro-to-comp)**: Computational foundations: Turing machines, computability, floating-point arithmetic, GPU architecture, and high-performance computing. Why computational constraints shape every algorithm we design.
- **[Basics of Machine Learning](ml-basics)**: Core ML concepts: loss functions, reinforcement learning, gradient descent, backpropagation, and regularization. The conceptual scaffold on which all subsequent mathematics hangs.
- **[Linear Algebra](linear-algebra)**: The language of ML: vector spaces, linear maps, eigendecomposition, SVD, PCA, and matrix calculus. How data, transformations, and geometry interrelate.
- **[Calculus and Optimization](calculus-and-optimization)**: Finding optimal parameters: multivariable calculus, convex and non-convex optimization, constrained optimization, and convergence theory.
- **[Probability and Statistics](probability-and-statistics)**: Reasoning under uncertainty: probability spaces, distributions, Bayesian inference, information theory, and statistical learning theory.
- **[Advanced ML Math](advanced-ml-math)**: Mathematical foundations of modern architectures: transformers and attention, diffusion models, graph neural networks, and optimal transport.

## Prerequisites

Comfort with single-variable calculus (derivatives, integrals, chain rule), basic linear algebra (matrix multiplication, determinants), and elementary probability (conditional probability, Bayes' theorem). Each chapter builds on the previous ones, so we recommend reading sequentially on a first pass.

## Notation Conventions

We use the following conventions throughout the textbook:

- **Scalars** are lowercase italic: $a, b, \lambda$
- **Vectors** are lowercase bold: $\mathbf{x}, \mathbf{v}, \mathbf{w}$
- **Matrices** are uppercase: $A, W, X$
- **Sets** are calligraphic or blackboard bold: $\mathcal{D}, \mathbb{R}^n$
- **Random variables** are uppercase: $X, Y$ (distinguished from matrices by context)
- **Probability** uses $P(\cdot)$ for discrete and $p(\cdot)$ for density functions
- **Norms** use double bars: $\|\mathbf{x}\|$, $\|A\|_F$
- **Transpose** is superscript $\top$: $A^\top$
- **Expectation, variance** use $\mathbb{E}[\cdot]$, $\text{Var}[\cdot]$

## References

This textbook draws on and is designed to complement these standard references:

- Strang, *Linear Algebra and Its Applications* [@strang2006linear]
- Boyd and Vandenberghe, *Convex Optimization* [@boyd2004convex]
- Bishop, *Pattern Recognition and Machine Learning* [@bishop2006pattern]
- Goodfellow, Bengio, and Courville, *Deep Learning* [@goodfellow2016deep]
- Cover and Thomas, *Elements of Information Theory* [@cover2006elements]
