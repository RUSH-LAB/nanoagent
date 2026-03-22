---
sidebar_position: 3
---

# Non-Convex Optimization

## The Non-Convex Landscape of Deep Learning

Neural network loss functions are highly non-convex. A network with $d$ parameters defines a loss surface in $\mathbb{R}^d$ with exponentially many critical points. Despite this, SGD reliably finds good solutions.

## Saddle Points vs Local Minima

At a critical point ($\nabla \mathcal{L} = 0$), the Hessian eigenvalues determine the type:

- **All positive:** local minimum
- **All negative:** local maximum
- **Mixed signs:** saddle point

In $d$ dimensions, the probability of a random critical point being a minimum is roughly $2^{-d}$. For a 100M-parameter model, saddle points outnumber local minima by a factor beyond comprehension.

**Key insight:** The main obstacle to optimization in deep learning is not bad local minima but saddle points and plateaus. SGD's noise naturally helps escape saddle points because the gradient noise pushes the iterate away from the unstable directions.

## Loss Surface Geometry

Empirical observations about neural network loss landscapes:

| Property | Observation |
|----------|-------------|
| Flat minima | Solutions found by SGD tend to lie in wide, flat valleys |
| Mode connectivity | Good minima are connected by low-loss paths |
| Linear mode connectivity | Solutions from the same training run can be linearly interpolated |
| Edge of stability | GD with large LR oscillates at the edge of stability ($\lambda_{\max}(H) \approx 2/\eta$) |

**Key insight:** Sharp minima generalize poorly because small perturbations to the weights cause large changes in the loss. Flat minima are robust to perturbation and generalize better. SGD and small batch sizes act as implicit regularizers that favor flat regions.

## Why Deep Networks Train Despite Non-Convexity

Several factors explain the practical success:

1. **Overparameterization:** More parameters than data points creates many global minima, and most are reachable by gradient descent.
2. **SGD noise:** Stochastic gradients help escape saddle points and sharp minima.
3. **Skip connections:** Residual connections create smooth loss landscapes.
4. **Normalization:** BatchNorm / LayerNorm smooth the loss surface.
5. **Random initialization:** Proper initialization (Kaiming, Xavier) places the initial parameters in a well-behaved region.

## Learning Rate Schedules

The learning rate is the single most important hyperparameter. Common schedules:

**Warmup:** Start with a small LR and linearly increase to the target over $w$ steps:

$$
\eta_t = \eta_{\max} \cdot \min\left(\frac{t}{w}, \, 1\right) \quad \text{for } t \leq w
$$

**Cosine decay:** Smoothly decrease the LR following a cosine curve:

$$
\eta_t = \eta_{\min} + \frac{1}{2}(\eta_{\max} - \eta_{\min})\left(1 + \cos\left(\frac{\pi (t - w)}{T - w}\right)\right) \quad \text{for } t > w
$$

**Warmup + cosine** is the standard for transformer training. The warmup phase stabilizes early training when the loss landscape is poorly conditioned; the cosine decay refines the solution in later stages.

| Schedule | Best for | Key parameter |
|----------|----------|---------------|
| Constant | Fine-tuning, small datasets | $\eta$ |
| Step decay | CNNs (ResNet-style) | Decay factor $\gamma$, step $s$ |
| Cosine | Transformers, pretraining | $\eta_{\min}$, $T$ |
| Warmup + cosine | Large-scale pretraining | Warmup steps $w$ |
| 1-cycle | Fast convergence | Max LR |

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\lambda_{\max}(H)$ | Largest eigenvalue of the Hessian |
| $\eta$ | Learning rate |
| $w$ | Number of warmup steps |
| $T$ | Total training steps |
| $\eta_{\min}, \eta_{\max}$ | Minimum and maximum learning rate |
| $\gamma$ | Decay factor for step schedule |
