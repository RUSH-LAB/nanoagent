---
sidebar_position: 5
---

# Statistical Learning Theory

## The Learning Problem

Given training data $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^n$ drawn i.i.d. from an unknown distribution $P$, find a hypothesis $h \in \mathcal{H}$ that minimizes the **true risk** (expected loss):

$$
R(h) = \mathbb{E}_{(x,y) \sim P}[\ell(h(x), y)]
$$

We can only compute the **empirical risk** (training loss):

$$
\hat{R}(h) = \frac{1}{n} \sum_{i=1}^n \ell(h(x_i), y_i)
$$

The gap $R(h) - \hat{R}(h)$ is the **generalization gap**.

## PAC Learning

A hypothesis class $\mathcal{H}$ is **PAC-learnable** (Probably Approximately Correct) if there exists an algorithm that, for any $\epsilon, \delta > 0$, given $n \geq n_0(\epsilon, \delta)$ samples, outputs $h$ such that:

$$
P(R(h) - R(h^*) \leq \epsilon) \geq 1 - \delta
$$

with polynomial sample complexity $n_0 = O\left(\frac{1}{\epsilon^2}\log\frac{|\mathcal{H}|}{\delta}\right)$ for finite $\mathcal{H}$.

**Key insight:** PAC learning formalizes the intuition that more complex hypothesis classes need more data. The sample complexity grows logarithmically with $|\mathcal{H}|$ for finite classes, but we need VC dimension for infinite classes (like neural networks).

## VC Dimension

The **VC dimension** $d_{\text{VC}}$ of a hypothesis class $\mathcal{H}$ is the largest number of points that $\mathcal{H}$ can **shatter** (classify correctly in all $2^d$ ways).

| Hypothesis class | VC dimension |
|-----------------|--------------|
| Linear classifiers in $\mathbb{R}^n$ | $n + 1$ |
| Axis-aligned rectangles in $\mathbb{R}^2$ | $4$ |
| Degree-$d$ polynomials | $d + 1$ |
| Neural networks (ReLU, $W$ params) | $O(W \log W)$ |

The **VC generalization bound** (Vapnik-Chervonenkis):

$$
R(h) \leq \hat{R}(h) + O\left(\sqrt{\frac{d_{\text{VC}} \log(n / d_{\text{VC}})}{n}}\right)
$$

with high probability. The bound tightens as $n$ grows and loosens as $d_{\text{VC}}$ grows.

## Rademacher Complexity

The **Rademacher complexity** of $\mathcal{H}$ measures how well the class can fit random noise:

$$
\mathfrak{R}_n(\mathcal{H}) = \mathbb{E}_{\sigma, S}\left[\sup_{h \in \mathcal{H}} \frac{1}{n} \sum_{i=1}^n \sigma_i h(x_i)\right]
$$

where $\sigma_i$ are i.i.d. Rademacher variables ($\pm 1$ with equal probability). The generalization bound is:

$$
R(h) \leq \hat{R}(h) + 2\mathfrak{R}_n(\mathcal{H}) + O\left(\sqrt{\frac{\log(1/\delta)}{n}}\right)
$$

**Key insight:** Rademacher complexity provides tighter bounds than VC dimension for specific data distributions. A class that fits random noise well (high $\mathfrak{R}_n$) will overfit; a class that cannot fit noise (low $\mathfrak{R}_n$) will generalize.

## Bias-Variance Decomposition

For squared loss, the expected prediction error decomposes:

$$
\mathbb{E}[(\hat{f}(x) - y)^2] = \text{Bias}^2 + \text{Variance} + \text{Noise}
$$

$$
= \left(\mathbb{E}[\hat{f}(x)] - f(x)\right)^2 + \mathbb{E}\left[(\hat{f}(x) - \mathbb{E}[\hat{f}(x)])^2\right] + \sigma^2
$$

| Complexity | Bias | Variance | Test Error |
|------------|------|----------|------------|
| Too simple | High | Low | High (underfitting) |
| Just right | Moderate | Moderate | Low |
| Too complex | Low | High | High (overfitting) |
| Very overparameterized | Low | Low | Low (double descent) |

## Why Overparameterized Models Generalize

Classical theory predicts that models with more parameters than data points should overfit. Modern neural networks violate this prediction. Explanations include:

1. **Implicit regularization:** SGD biases toward low-complexity solutions
2. **Flat minima:** Solutions found by SGD have low curvature, which corresponds to low effective complexity
3. **Norm-based bounds:** Generalization depends on weight norms, not parameter count
4. **Neural tangent kernel:** In the infinite-width limit, training is equivalent to kernel regression

**Key insight:** The effective complexity of a neural network is much smaller than its parameter count. Generalization bounds based on parameter count are vacuously loose; bounds based on norms, margins, or compression are more informative.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $R(h)$ | True risk (expected loss) |
| $\hat{R}(h)$ | Empirical risk (training loss) |
| $\mathcal{H}$ | Hypothesis class |
| $d_{\text{VC}}$ | VC dimension |
| $\mathfrak{R}_n$ | Rademacher complexity |
| $\epsilon, \delta$ | PAC parameters (accuracy, confidence) |
| $\sigma_i$ | Rademacher random variable ($\pm 1$) |
| $n$ | Number of training samples |
