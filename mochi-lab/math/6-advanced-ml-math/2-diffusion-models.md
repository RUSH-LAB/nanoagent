---
sidebar_position: 2
---

# Diffusion Models

## Forward Process

The **forward (diffusion) process** gradually adds Gaussian noise to data $x_0 \sim q(x_0)$ over $T$ steps:

$$
q(x_t | x_{t-1}) = \mathcal{N}(x_t; \sqrt{1 - \beta_t} \, x_{t-1}, \, \beta_t I)
$$

where $\beta_t \in (0, 1)$ is the noise schedule. Using $\alpha_t = 1 - \beta_t$ and $\bar{\alpha}_t = \prod_{s=1}^t \alpha_s$, we can sample $x_t$ directly from $x_0$:

$$
q(x_t | x_0) = \mathcal{N}(x_t; \sqrt{\bar{\alpha}_t} \, x_0, \, (1 - \bar{\alpha}_t) I)
$$

$$
x_t = \sqrt{\bar{\alpha}_t} \, x_0 + \sqrt{1 - \bar{\alpha}_t} \, \epsilon, \quad \epsilon \sim \mathcal{N}(0, I)
$$

As $t \to T$ (with appropriate schedule), $x_T \approx \mathcal{N}(0, I)$.

**Key insight:** The forward process is completely deterministic given $x_0$ and $\epsilon$. No neural networks are involved. The "diffusion" is simply adding noise on a schedule.

## Reverse Process

The **reverse process** learns to denoise, going from noise to data:

$$
p_\theta(x_{t-1} | x_t) = \mathcal{N}(x_{t-1}; \mu_\theta(x_t, t), \, \sigma_t^2 I)
$$

where $\mu_\theta$ is predicted by a neural network. The model can equivalently predict the noise $\epsilon_\theta(x_t, t)$, with:

$$
\mu_\theta(x_t, t) = \frac{1}{\sqrt{\alpha_t}} \left(x_t - \frac{\beta_t}{\sqrt{1 - \bar{\alpha}_t}} \epsilon_\theta(x_t, t)\right)
$$

## DDPM Loss

The DDPM (Denoising Diffusion Probabilistic Model) training objective simplifies to:

$$
\mathcal{L}_{\text{simple}} = \mathbb{E}_{t, x_0, \epsilon}\left[\|\epsilon - \epsilon_\theta(x_t, t)\|^2\right]
$$

where $t \sim \text{Uniform}(1, T)$, $x_0 \sim q(x_0)$, and $\epsilon \sim \mathcal{N}(0, I)$.

This is derived from the variational lower bound on $-\log p_\theta(x_0)$, which decomposes into a sum of KL divergences between the forward posterior $q(x_{t-1}|x_t, x_0)$ and the learned reverse $p_\theta(x_{t-1}|x_t)$.

**Key insight:** The training objective is simply "predict the noise that was added." This is a regression problem -- the model learns to estimate $\epsilon$ from the noisy input $x_t$, and the loss is MSE.

## Score Matching

The **score function** is the gradient of the log-density: $\nabla_x \log p(x)$. Score matching trains a model $s_\theta(x) \approx \nabla_x \log p(x)$.

The connection to diffusion: the noise prediction $\epsilon_\theta$ is related to the score by:

$$
s_\theta(x_t, t) = -\frac{\epsilon_\theta(x_t, t)}{\sqrt{1 - \bar{\alpha}_t}}
$$

**Key insight:** Predicting noise, predicting the score, and predicting the clean data are all mathematically equivalent formulations. They differ only in how the loss is weighted across noise levels.

## Classifier-Free Guidance

**Classifier-free guidance** (CFG) combines conditional and unconditional models:

$$
\tilde{\epsilon}_\theta(x_t, t, c) = (1 + w) \, \epsilon_\theta(x_t, t, c) - w \, \epsilon_\theta(x_t, t, \varnothing)
$$

where $c$ is the conditioning (e.g., text prompt), $\varnothing$ is the null condition, and $w > 0$ is the guidance scale. Higher $w$ increases adherence to the condition at the cost of diversity.

**Key insight:** CFG amplifies the difference between the conditional and unconditional predictions. This pushes samples toward regions where the conditioning signal is strong, trading diversity for quality/relevance.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $x_0$ | Clean data |
| $x_t$ | Noisy data at timestep $t$ |
| $\beta_t$ | Noise schedule at step $t$ |
| $\alpha_t = 1 - \beta_t$ | Signal retention |
| $\bar{\alpha}_t$ | Cumulative signal retention $\prod_{s \leq t} \alpha_s$ |
| $\epsilon$ | Gaussian noise |
| $\epsilon_\theta$ | Predicted noise (neural network) |
| $s_\theta$ | Score function estimate |
| $c$ | Conditioning signal |
| $w$ | Guidance scale |
