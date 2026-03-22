---
sidebar_position: 5
---

# Regularization

## The Overfitting Problem

A model with sufficient capacity can memorize the training set ($\mathcal{L}_{\text{train}} \approx 0$) while performing poorly on unseen data ($\mathcal{L}_{\text{test}} \gg 0$). Regularization constrains the model to prefer simpler hypotheses that generalize.

## L2 Regularization (Ridge)

<Definition id="def-l2-reg" name="L2 Regularization">
Add the squared norm of parameters to the loss:

<Equation id="eq-l2-reg">

$$\mathcal{L}_{\text{reg}} = \mathcal{L}(\theta) + \frac{\lambda}{2} \|\theta\|_2^2 = \mathcal{L}(\theta) + \frac{\lambda}{2} \sum_i \theta_i^2$$

</Equation>
</Definition>

The gradient becomes $\nabla \mathcal{L}_{\text{reg}} = \nabla \mathcal{L} + \lambda \theta$, so the update rule is:

<Equation id="eq-weight-decay">

$$\theta_{t+1} = \theta_t - \eta(\nabla \mathcal{L} + \lambda \theta_t) = (1 - \eta\lambda)\theta_t - \eta \nabla \mathcal{L}$$

</Equation>

The factor $(1 - \eta\lambda)$ shrinks weights toward zero each step. This is equivalent to **weight decay** when using vanilla SGD, but differs for Adam (where AdamW decouples weight decay from the adaptive learning rate) [@loshchilov2019adamw].

<Remark id="rmk-l2-bayesian">
L2 regularization is equivalent to a Gaussian prior $p(\theta) \propto e^{-\lambda\|\theta\|^2/2}$ on the parameters. MAP estimation under this prior gives the L2-regularized objective.
</Remark>

## L1 Regularization (Lasso)

<Definition id="def-l1-reg" name="L1 Regularization">
Add the absolute value of parameters:

<Equation id="eq-l1-reg">

$$\mathcal{L}_{\text{reg}} = \mathcal{L}(\theta) + \lambda \|\theta\|_1 = \mathcal{L}(\theta) + \lambda \sum_i |\theta_i|$$

</Equation>
</Definition>

L1 drives parameters exactly to zero (sparsity) because the subgradient $\text{sign}(\theta_i)$ applies constant pressure regardless of magnitude.

<Table id="tab-l1-vs-l2" caption="Comparison of L1 and L2 regularization.">

| Property | L1 | L2 |
|----------|----|----|
| Penalty | $\lambda \sum |\theta_i|$ | $\frac{\lambda}{2} \sum \theta_i^2$ |
| Effect | Sparsity (feature selection) | Small weights (shrinkage) |
| Prior | Laplace | Gaussian |
| Solution geometry | Diamond (corners on axes) | Sphere |

</Table>

## Dropout

<Definition id="def-dropout" name="Dropout">
During training, randomly zero out each neuron with probability $p$ (typically $p = 0.1$ to $0.5$) [@srivastava2014dropout]:

<Equation id="eq-dropout">

$$h_l^{\text{drop}} = h_l \odot m, \quad m_i \sim \text{Bernoulli}(1 - p)$$

</Equation>

At test time, multiply activations by $(1 - p)$ (or equivalently, scale during training by $1/(1 - p)$: **inverted dropout**).

$$
\text{Train: } \quad \tilde{h} = \frac{1}{1 - p} \cdot h \odot m \qquad \text{Test: } \quad \tilde{h} = h
$$
</Definition>

<Remark id="rmk-dropout-ensemble">
Dropout is equivalent to training an exponential ensemble of $2^n$ sub-networks (where $n$ is the number of neurons) and averaging their predictions at test time. It can also be interpreted as approximate Bayesian inference.
</Remark>

## Early Stopping

<Definition id="def-early-stopping" name="Early Stopping">
Monitor validation loss during training and stop when it begins to increase:

<Equation id="eq-early-stopping">

$$\theta^* = \theta_{t^*}, \quad t^* = \arg\min_{t} \mathcal{L}_{\text{val}}(\theta_t)$$

</Equation>

In practice, use **patience** $k$: stop if validation loss has not improved for $k$ consecutive evaluations.
</Definition>

Early stopping implicitly limits the effective number of parameters by restricting how far $\theta$ moves from initialization.

<Remark id="rmk-early-stopping-l2">
For linear models, early stopping with gradient descent is equivalent to L2 regularization with $\lambda \propto 1/t$. The number of training steps acts as an inverse regularization strength.
</Remark>

## Bias-Variance Tradeoff

<Theorem id="thm-bias-variance" name="Bias-Variance Decomposition">
The expected test error decomposes as:

<Equation id="eq-bias-variance">

$$\mathbb{E}[(\hat{f}(x) - y)^2] = \underbrace{(\mathbb{E}[\hat{f}(x)] - f(x))^2}_{\text{bias}^2} + \underbrace{\mathbb{E}[(\hat{f}(x) - \mathbb{E}[\hat{f}(x)])^2]}_{\text{variance}} + \underbrace{\sigma^2}_{\text{irreducible noise}}$$

</Equation>
</Theorem>

<Table id="tab-bias-variance" caption="Bias-variance tradeoff regimes.">

| Regime | Bias | Variance | Risk |
|--------|------|----------|------|
| Underfitting | High | Low | Model too simple |
| Overfitting | Low | High | Model too complex |
| Optimal | Balanced | Balanced | Best generalization |

</Table>

Regularization increases bias but decreases variance. The optimal $\lambda$ minimizes the sum.

<Remark id="rmk-double-descent">
Modern deep learning operates in the "double descent" regime where very overparameterized models can have low bias and low variance simultaneously -- contradicting the classical tradeoff [@nakkiran2021deep]. This is partly explained by implicit regularization from SGD and the structure of neural network loss landscapes.
</Remark>

## Notation Summary

<Table id="tab-notation-reg" caption="Notation used in regularization.">

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

</Table>
