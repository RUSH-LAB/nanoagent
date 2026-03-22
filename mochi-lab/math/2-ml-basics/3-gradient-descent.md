---
sidebar_position: 3
---

# Gradient Descent

## The Optimization Problem

Machine learning reduces to finding parameters $\theta$ that minimize a loss function $\mathcal{L}(\theta)$ over a dataset $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^N$:

$$
\theta^* = \arg\min_\theta \frac{1}{N} \sum_{i=1}^{N} \ell(f_\theta(x_i), y_i)
$$

Gradient descent solves this by iteratively moving in the direction of steepest descent.

## Vanilla Gradient Descent

The update rule computes the gradient over the full dataset:

$$
\theta_{t+1} = \theta_t - \eta \nabla_\theta \mathcal{L}(\theta_t) = \theta_t - \eta \cdot \frac{1}{N} \sum_{i=1}^{N} \nabla_\theta \ell(f_\theta(x_i), y_i)
$$

where $\eta > 0$ is the **learning rate**. This converges for convex $\mathcal{L}$ when $\eta < 2/L$ (where $L$ is the Lipschitz constant of $\nabla \mathcal{L}$), but requires $O(N)$ computation per step.

## Stochastic Gradient Descent (SGD)

SGD approximates the full gradient with a single sample or mini-batch $\mathcal{B} \subset \mathcal{D}$:

$$
\theta_{t+1} = \theta_t - \eta \cdot \frac{1}{|\mathcal{B}|} \sum_{i \in \mathcal{B}} \nabla_\theta \ell(f_\theta(x_i), y_i)
$$

The stochastic gradient $g_t$ is an unbiased estimate: $\mathbb{E}[g_t] = \nabla \mathcal{L}(\theta_t)$. The variance decreases as $O(1/|\mathcal{B}|)$ but each step costs $O(|\mathcal{B}|)$ instead of $O(N)$.

**Key insight:** The noise in SGD acts as implicit regularization -- it helps escape sharp minima and find flatter regions of the loss landscape that generalize better.

## Momentum

SGD oscillates in directions with high curvature. **Momentum** adds a velocity term that accumulates past gradients:

$$
v_{t+1} = \mu \, v_t + \nabla \mathcal{L}(\theta_t), \quad \theta_{t+1} = \theta_t - \eta \, v_{t+1}
$$

where $\mu \in [0, 1)$ is the momentum coefficient (typically 0.9). This dampens oscillations and accelerates convergence along consistent gradient directions.

**Nesterov momentum** evaluates the gradient at the "look-ahead" position:

$$
v_{t+1} = \mu \, v_t + \nabla \mathcal{L}(\theta_t - \eta \mu v_t), \quad \theta_{t+1} = \theta_t - \eta \, v_{t+1}
$$

## Adam

**Adam** (Adaptive Moment Estimation) combines momentum with per-parameter adaptive learning rates by tracking the first and second moments of the gradient:

$$
m_t = \beta_1 m_{t-1} + (1 - \beta_1) g_t, \quad v_t = \beta_2 v_{t-1} + (1 - \beta_2) g_t^2
$$

$$
\hat{m}_t = \frac{m_t}{1 - \beta_1^t}, \quad \hat{v}_t = \frac{v_t}{1 - \beta_2^t}
$$

$$
\theta_{t+1} = \theta_t - \eta \frac{\hat{m}_t}{\sqrt{\hat{v}_t} + \epsilon}
$$

Default hyperparameters: $\beta_1 = 0.9$, $\beta_2 = 0.999$, $\epsilon = 10^{-8}$.

**Key insight:** Adam adapts the effective learning rate for each parameter. Parameters with large gradients get smaller updates; parameters with small gradients get larger updates. The bias correction terms $\hat{m}_t, \hat{v}_t$ prevent the initial estimates from being biased toward zero.

## Learning Rate Schedules

| Schedule | Formula | When used |
|----------|---------|-----------|
| Constant | $\eta_t = \eta_0$ | Baselines, fine-tuning |
| Step decay | $\eta_t = \eta_0 \cdot \gamma^{\lfloor t/s \rfloor}$ | CNNs (ResNet) |
| Cosine | $\eta_t = \eta_{\min} + \frac{1}{2}(\eta_0 - \eta_{\min})(1 + \cos(\pi t / T))$ | Transformers |
| Warmup + decay | Linear warmup for $w$ steps, then cosine | Large-scale pretraining |

## Convergence Rates

| Setting | Algorithm | Rate |
|---------|-----------|------|
| Convex, Lipschitz | GD | $O(1/t)$ |
| Strongly convex | GD | $O(e^{-t})$ linear |
| Convex | SGD | $O(1/\sqrt{t})$ |
| Non-convex | SGD | $O(1/\sqrt{t})$ to stationary point |

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\theta$ | Model parameters |
| $\eta$ | Learning rate |
| $\mathcal{L}$ | Loss function |
| $g_t$ | Gradient (or stochastic gradient) at step $t$ |
| $v_t$ | Velocity (momentum) or second moment (Adam) |
| $m_t$ | First moment estimate (Adam) |
| $\beta_1, \beta_2$ | Exponential decay rates (Adam) |
| $\mu$ | Momentum coefficient |
| $L$ | Lipschitz constant of the gradient |
| $|\mathcal{B}|$ | Mini-batch size |
