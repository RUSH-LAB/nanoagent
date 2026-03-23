---
sidebar_position: 2
---

# Diffusion Models

## Forward Process

<Definition id="def-forward-diffusion" name="Forward Diffusion Process">
The **forward (diffusion) process** gradually adds Gaussian noise to data $x_0 \sim q(x_0)$ over $T$ steps [@ho2020ddpm]:

<Equation id="eq-forward-step">

$$q(x_t | x_{t-1}) = \mathcal{N}(x_t; \sqrt{1 - \beta_t} \, x_{t-1}, \, \beta_t I)$$

</Equation>

where $\beta_t \in (0, 1)$ is the noise schedule. Using $\alpha_t = 1 - \beta_t$ and $\bar{\alpha}_t = \prod_{s=1}^t \alpha_s$, we can sample $x_t$ directly from $x_0$:

<Equation id="eq-forward-closed">

$$q(x_t | x_0) = \mathcal{N}(x_t; \sqrt{\bar{\alpha}_t} \, x_0, \, (1 - \bar{\alpha}_t) I)$$

</Equation>

$$
x_t = \sqrt{\bar{\alpha}_t} \, x_0 + \sqrt{1 - \bar{\alpha}_t} \, \epsilon, \quad \epsilon \sim \mathcal{N}(0, I)
$$
</Definition>

As $t \to T$ (with appropriate schedule), $x_T \approx \mathcal{N}(0, I)$.

<Remark id="rmk-forward-deterministic">
The forward process is completely deterministic given $x_0$ and $\epsilon$. No neural networks are involved. The "diffusion" is simply adding noise on a schedule.
</Remark>

## Reverse Process

<Definition id="def-reverse-diffusion" name="Reverse Diffusion Process">
The **reverse process** learns to denoise, going from noise to data:

<Equation id="eq-reverse-step">

$$p_\theta(x_{t-1} | x_t) = \mathcal{N}(x_{t-1}; \mu_\theta(x_t, t), \, \sigma_t^2 I)$$

</Equation>

where $\mu_\theta$ is predicted by a neural network. The model can equivalently predict the noise $\epsilon_\theta(x_t, t)$, with:

<Equation id="eq-reverse-mean">

$$\mu_\theta(x_t, t) = \frac{1}{\sqrt{\alpha_t}} \left(x_t - \frac{\beta_t}{\sqrt{1 - \bar{\alpha}_t}} \epsilon_\theta(x_t, t)\right)$$

</Equation>
</Definition>

## DDPM Loss

<Theorem id="thm-ddpm-loss" name="DDPM Training Objective">
The DDPM (Denoising Diffusion Probabilistic Model) training objective simplifies to:

<Equation id="eq-ddpm-loss">

$$\mathcal{L}_{\text{simple}} = \mathbb{E}_{t, x_0, \epsilon}\left[\|\epsilon - \epsilon_\theta(x_t, t)\|^2\right]$$

</Equation>

where $t \sim \text{Uniform}(1, T)$, $x_0 \sim q(x_0)$, and $\epsilon \sim \mathcal{N}(0, I)$.
</Theorem>

This is derived from the variational lower bound on $-\log p_\theta(x_0)$, which decomposes into a sum of KL divergences between the forward posterior $q(x_{t-1}|x_t, x_0)$ and the learned reverse $p_\theta(x_{t-1}|x_t)$.

<Remark id="rmk-ddpm-regression">
The training objective is simply "predict the noise that was added." This is a regression problem -- the model learns to estimate $\epsilon$ from the noisy input $x_t$, and the loss is MSE.
</Remark>

## Score Matching

<Definition id="def-score-function" name="Score Function">
The **score function** is the gradient of the log-density: $\nabla_x \log p(x)$. Score matching trains a model $s_\theta(x) \approx \nabla_x \log p(x)$ [@song2019score].

The connection to diffusion: the noise prediction $\epsilon_\theta$ is related to the score by:

<Equation id="eq-score-noise">

$$s_\theta(x_t, t) = -\frac{\epsilon_\theta(x_t, t)}{\sqrt{1 - \bar{\alpha}_t}}$$

</Equation>
</Definition>

<Remark id="rmk-score-equivalence">
Predicting noise, predicting the score, and predicting the clean data are all mathematically equivalent formulations. They differ only in how the loss is weighted across noise levels.
</Remark>

## Classifier-Free Guidance

<Definition id="def-cfg" name="Classifier-Free Guidance">
**Classifier-free guidance** (CFG) [@ho2022cfg] combines conditional and unconditional models:

<Equation id="eq-cfg">

$$\tilde{\epsilon}_\theta(x_t, t, c) = (1 + w) \, \epsilon_\theta(x_t, t, c) - w \, \epsilon_\theta(x_t, t, \varnothing)$$

</Equation>

where $c$ is the conditioning (e.g., text prompt), $\varnothing$ is the null condition, and $w > 0$ is the guidance scale.
</Definition>

Higher $w$ increases adherence to the condition at the cost of diversity.

<Remark id="rmk-cfg-mechanism">
CFG amplifies the difference between the conditional and unconditional predictions. This pushes samples toward regions where the conditioning signal is strong, trading diversity for quality/relevance.
</Remark>

## Notation Summary

<Table id="tab-notation-diffusion" caption="Notation used in diffusion models.">

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

</Table>
