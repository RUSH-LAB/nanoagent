---
sidebar_position: 5
---

# Regularization

## The Overfitting Problem

A model with sufficient capacity can memorize the training set ($\mathcal{L}_{\text{train}} \approx 0$) while performing poorly on unseen data ($\mathcal{L}_{\text{test}} \gg 0$). Regularization constrains the model to prefer simpler hypotheses that generalize.

## L2 Regularization (Ridge)

Add the squared norm of parameters to the loss:

$$
\mathcal{L}_{\text{reg}} = \mathcal{L}(\theta) + \frac{\lambda}{2} \|\theta\|_2^2 = \mathcal{L}(\theta) + \frac{\lambda}{2} \sum_i \theta_i^2
$$

The gradient becomes $\nabla \mathcal{L}_{\text{reg}} = \nabla \mathcal{L} + \lambda \theta$, so the update rule is:

$$
\theta_{t+1} = \theta_t - \eta(\nabla \mathcal{L} + \lambda \theta_t) = (1 - \eta\lambda)\theta_t - \eta \nabla \mathcal{L}
$$

The factor $(1 - \eta\lambda)$ shrinks weights toward zero each step. This is equivalent to **weight decay** when using vanilla SGD, but differs for Adam (where AdamW decouples weight decay from the adaptive learning rate).

**Key insight:** L2 regularization is equivalent to a Gaussian prior $p(\theta) \propto e^{-\lambda\|\theta\|^2/2}$ on the parameters. MAP estimation under this prior gives the L2-regularized objective.

## L1 Regularization (Lasso)

Add the absolute value of parameters:

$$
\mathcal{L}_{\text{reg}} = \mathcal{L}(\theta) + \lambda \|\theta\|_1 = \mathcal{L}(\theta) + \lambda \sum_i |\theta_i|
$$

L1 drives parameters exactly to zero (sparsity) because the subgradient $\text{sign}(\theta_i)$ applies constant pressure regardless of magnitude.

| Property | L1 | L2 |
|----------|----|----|
| Penalty | $\lambda \sum |\theta_i|$ | $\frac{\lambda}{2} \sum \theta_i^2$ |
| Effect | Sparsity (feature selection) | Small weights (shrinkage) |
| Prior | Laplace | Gaussian |
| Solution geometry | Diamond (corners on axes) | Sphere |

## Dropout

During training, randomly zero out each neuron with probability $p$ (typically $p = 0.1$ to $0.5$):

$$
h_l^{\text{drop}} = h_l \odot m, \quad m_i \sim \text{Bernoulli}(1 - p)
$$

At test time, multiply activations by $(1 - p)$ (or equivalently, scale during training by $1/(1 - p)$: **inverted dropout**).

$$
\text{Train: } \quad \tilde{h} = \frac{1}{1 - p} \cdot h \odot m \qquad \text{Test: } \quad \tilde{h} = h
$$

**Key insight:** Dropout is equivalent to training an exponential ensemble of $2^n$ sub-networks (where $n$ is the number of neurons) and averaging their predictions at test time. It can also be interpreted as approximate Bayesian inference.

## Early Stopping

Monitor validation loss during training and stop when it begins to increase:

$$
\theta^* = \theta_{t^*}, \quad t^* = \arg\min_{t} \mathcal{L}_{\text{val}}(\theta_t)
$$

In practice, use **patience** $k$: stop if validation loss has not improved for $k$ consecutive evaluations. Early stopping implicitly limits the effective number of parameters by restricting how far $\theta$ moves from initialization.

**Key insight:** For linear models, early stopping with gradient descent is equivalent to L2 regularization with $\lambda \propto 1/t$. The number of training steps acts as an inverse regularization strength.

## Bias-Variance Tradeoff

The expected test error decomposes as:

$$
\mathbb{E}[(\hat{f}(x) - y)^2] = \underbrace{(\mathbb{E}[\hat{f}(x)] - f(x))^2}_{\text{bias}^2} + \underbrace{\mathbb{E}[(\hat{f}(x) - \mathbb{E}[\hat{f}(x)])^2]}_{\text{variance}} + \underbrace{\sigma^2}_{\text{irreducible noise}}
$$

| Regime | Bias | Variance | Risk |
|--------|------|----------|------|
| Underfitting | High | Low | Model too simple |
| Overfitting | Low | High | Model too complex |
| Optimal | Balanced | Balanced | Best generalization |

Regularization increases bias but decreases variance. The optimal $\lambda$ minimizes the sum.

**Key insight:** Modern deep learning operates in the "double descent" regime where very overparameterized models can have low bias and low variance simultaneously -- contradicting the classical tradeoff. This is partly explained by implicit regularization from SGD and the structure of neural network loss landscapes.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\lambda$ | Regularization strength |
| $\|\theta\|_1, \|\theta\|_2$ | L1 and L2 norms of parameters |
| $p$ | Dropout probability |
| $m$ | Binary dropout mask |
| $\odot$ | Elementwise product |
| $\hat{f}$ | Learned predictor |
| $f$ | True function |
| $\sigma^2$ | Irreducible noise variance |
