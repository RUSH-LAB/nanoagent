---
sidebar_position: 2
---

# Diffusion Models

Diffusion models are a class of generative models that learn to reverse a noise-corruption process. They have become the dominant approach for image, video, and audio generation, achieving state-of-the-art sample quality while offering stable training (no adversarial dynamics) and a principled variational objective. This chapter covers the mathematical foundations: the forward and reverse processes, the training objective and its derivation, the connection to score matching, and practical techniques like guidance.

## Forward Process

<Definition id="def-forward-diffusion" name="Forward Diffusion Process">
The **forward (diffusion) process** gradually adds Gaussian noise to data $x_0 \sim q(x_0)$ over $T$ steps [@ho2020ddpm]:

<Equation id="eq-forward-step">

$$q(x_t | x_{t-1}) = \mathcal{N}(x_t; \sqrt{1 - \beta_t} \, x_{t-1}, \, \beta_t I)$$

</Equation>

where $\beta_t \in (0, 1)$ is the **noise schedule**. Each step scales down the signal by $\sqrt{1 - \beta_t}$ and adds noise with variance $\beta_t$, preserving unit variance when the input has unit variance.
</Definition>

<Remark id="rmk-forward-closed-form">
**Closed-form sampling at any timestep.** Using $\alpha_t = 1 - \beta_t$ and $\bar{\alpha}_t = \prod_{s=1}^t \alpha_s$, we can sample $x_t$ directly from $x_0$ without iterating through intermediate steps:

<Equation id="eq-forward-closed">

$$q(x_t | x_0) = \mathcal{N}(x_t; \sqrt{\bar{\alpha}_t} \, x_0, \, (1 - \bar{\alpha}_t) I)$$

</Equation>

Equivalently: $x_t = \sqrt{\bar{\alpha}_t} \, x_0 + \sqrt{1 - \bar{\alpha}_t} \, \epsilon$ where $\epsilon \sim \mathcal{N}(0, I)$.

**Proof.** By induction. At step 1: $x_1 = \sqrt{\alpha_1}x_0 + \sqrt{\beta_1}\epsilon_1$. Assume $x_{t-1} = \sqrt{\bar{\alpha}_{t-1}}x_0 + \sqrt{1 - \bar{\alpha}_{t-1}}\bar{\epsilon}$. Then $x_t = \sqrt{\alpha_t}x_{t-1} + \sqrt{\beta_t}\epsilon_t = \sqrt{\alpha_t \bar{\alpha}_{t-1}}x_0 + \sqrt{\alpha_t(1 - \bar{\alpha}_{t-1})}\bar{\epsilon} + \sqrt{\beta_t}\epsilon_t$. Since $\bar{\epsilon}$ and $\epsilon_t$ are independent Gaussians, their sum has variance $\alpha_t(1 - \bar{\alpha}_{t-1}) + \beta_t = 1 - \alpha_t\bar{\alpha}_{t-1} = 1 - \bar{\alpha}_t$. $\square$
</Remark>

As $t \to T$ (with appropriate schedule), $\bar{\alpha}_T \approx 0$, so $x_T \approx \mathcal{N}(0, I)$ -- the data signal is completely destroyed.

<Remark id="rmk-noise-schedules">
**Noise schedules.** The choice of $\beta_t$ (or equivalently $\bar{\alpha}_t$) significantly affects generation quality:

| Schedule | $\beta_t$ or SNR | Properties |
|----------|----------|------------|
| Linear [@ho2020ddpm] | $\beta_t = \beta_1 + \frac{t-1}{T-1}(\beta_T - \beta_1)$ | Simple, but wastes steps in near-noise regime |
| Cosine [@nichol2021improved] | $\bar{\alpha}_t = \cos^2(\frac{t/T + s}{1+s} \cdot \frac{\pi}{2})$ | Smoother SNR decay, better for small images |
| Squared cosine | $\bar{\alpha}_t$ quadratic | Used in Stable Diffusion |
| Log-SNR linear | $\log(\bar{\alpha}_t / (1 - \bar{\alpha}_t))$ linear in $t$ | Uniform in log-SNR space; theoretically motivated |

The **signal-to-noise ratio (SNR)** at step $t$ is $\text{SNR}(t) = \bar{\alpha}_t / (1 - \bar{\alpha}_t)$, which monotonically decreases from $\infty$ to $0$. The schedule should distribute steps evenly across the useful SNR range.
</Remark>

<Remark id="rmk-forward-deterministic">
The forward process is completely deterministic given $x_0$ and $\epsilon$. No neural networks are involved. The "diffusion" is simply a prescribed schedule of noise addition. This means training data can be generated on-the-fly: sample $x_0$ from the dataset, sample $t \sim \text{Uniform}(1,T)$, sample $\epsilon \sim \mathcal{N}(0,I)$, and compute $x_t$ analytically.
</Remark>

## Reverse Process

<Definition id="def-reverse-diffusion" name="Reverse Diffusion Process">
The **reverse process** learns to denoise, generating data from noise by iterating:

<Equation id="eq-reverse-step">

$$p_\theta(x_{t-1} | x_t) = \mathcal{N}(x_{t-1}; \mu_\theta(x_t, t), \, \sigma_t^2 I)$$

</Equation>

where $\mu_\theta$ is predicted by a neural network. The variance $\sigma_t^2$ can be fixed ($\sigma_t^2 = \beta_t$ or $\sigma_t^2 = \tilde{\beta}_t = \frac{1-\bar{\alpha}_{t-1}}{1-\bar{\alpha}_t}\beta_t$) or learned.
</Definition>

<Remark id="rmk-parameterization">
**Three equivalent parameterizations.** The model can predict any of three quantities, and the mean $\mu_\theta$ is derived from the prediction:

| Parameterization | Model predicts | Mean formula | Loss weight |
|-----------------|---------------|-------------|-------------|
| **Noise prediction** ($\epsilon$-pred) | $\epsilon_\theta(x_t, t) \approx \epsilon$ | $\mu_\theta = \frac{1}{\sqrt{\alpha_t}}\left(x_t - \frac{\beta_t}{\sqrt{1-\bar{\alpha}_t}}\epsilon_\theta\right)$ | Uniform across noise levels |
| **Data prediction** ($x_0$-pred) | $\hat{x}_\theta(x_t, t) \approx x_0$ | $\mu_\theta = \frac{\sqrt{\bar{\alpha}_{t-1}}\beta_t}{1-\bar{\alpha}_t}\hat{x}_\theta + \frac{\sqrt{\alpha_t}(1-\bar{\alpha}_{t-1})}{1-\bar{\alpha}_t}x_t$ | Emphasizes low-noise steps |
| **Velocity prediction** ($v$-pred) | $v_\theta \approx \sqrt{\bar{\alpha}_t}\epsilon - \sqrt{1-\bar{\alpha}_t}x_0$ | Derived from $v_\theta$ | Balanced; better for high resolution |

All three are mathematically equivalent -- they differ only in the implicit weighting of the loss across noise levels. $\epsilon$-prediction is the default in DDPM; $v$-prediction is preferred in progressive distillation and high-resolution models.
</Remark>

## The Forward Posterior

<Theorem id="thm-forward-posterior" name="Forward Process Posterior">
The forward process posterior $q(x_{t-1} | x_t, x_0)$ -- the distribution of the previous step given both the current noisy version and the original data -- is tractable:

<Equation id="eq-forward-posterior">

$$q(x_{t-1} | x_t, x_0) = \mathcal{N}(x_{t-1}; \tilde{\mu}_t(x_t, x_0), \tilde{\beta}_t I)$$

</Equation>

where:

$$\tilde{\mu}_t = \frac{\sqrt{\bar{\alpha}_{t-1}} \beta_t}{1 - \bar{\alpha}_t} x_0 + \frac{\sqrt{\alpha_t}(1 - \bar{\alpha}_{t-1})}{1 - \bar{\alpha}_t} x_t, \qquad \tilde{\beta}_t = \frac{1 - \bar{\alpha}_{t-1}}{1 - \bar{\alpha}_t} \beta_t$$

This is derived by applying Bayes' rule: $q(x_{t-1}|x_t, x_0) \propto q(x_t|x_{t-1}) \cdot q(x_{t-1}|x_0)$, and completing the square in the Gaussian exponent.
</Theorem>

<Remark id="rmk-posterior-key-insight">
**The key insight of DDPM.** The forward posterior $q(x_{t-1}|x_t, x_0)$ is the "ideal" reverse step -- if we knew $x_0$, we could denoise perfectly. Since we do not know $x_0$, we train a neural network to estimate it (or equivalently, to estimate the noise $\epsilon$ that was added). Substituting the estimate $\hat{x}_0 = (x_t - \sqrt{1-\bar{\alpha}_t}\epsilon_\theta) / \sqrt{\bar{\alpha}_t}$ into $\tilde{\mu}_t$ gives the learned reverse mean.
</Remark>

## DDPM Loss

<Theorem id="thm-ddpm-loss" name="DDPM Training Objective">
The variational lower bound (VLB) on $-\log p_\theta(x_0)$ decomposes into a sum of KL divergences:

$$-\log p_\theta(x_0) \leq \underbrace{D_{\text{KL}}(q(x_T|x_0) \| p(x_T))}_{L_T \text{ (prior matching)}} + \sum_{t=2}^T \underbrace{D_{\text{KL}}(q(x_{t-1}|x_t, x_0) \| p_\theta(x_{t-1}|x_t))}_{L_{t-1} \text{ (denoising matching)}} - \underbrace{\log p_\theta(x_0|x_1)}_{L_0 \text{ (reconstruction)}}$$

Since both $q(x_{t-1}|x_t, x_0)$ and $p_\theta(x_{t-1}|x_t)$ are Gaussian, each KL term has a closed form that reduces to an MSE between means.

The **simplified loss** drops the per-timestep weighting:

<Equation id="eq-ddpm-loss">

$$\mathcal{L}_{\text{simple}} = \mathbb{E}_{t, x_0, \epsilon}\left[\|\epsilon - \epsilon_\theta(x_t, t)\|^2\right]$$

</Equation>

where $t \sim \text{Uniform}(1, T)$, $x_0 \sim q(x_0)$, and $\epsilon \sim \mathcal{N}(0, I)$.
</Theorem>

<Remark id="rmk-ddpm-regression">
**Training is denoising regression.** The training loop is remarkably simple:

1. Sample a clean image $x_0$ from the dataset
2. Sample $t \sim \text{Uniform}(1, T)$ and $\epsilon \sim \mathcal{N}(0, I)$
3. Compute $x_t = \sqrt{\bar{\alpha}_t}x_0 + \sqrt{1-\bar{\alpha}_t}\epsilon$
4. Predict $\hat{\epsilon} = \epsilon_\theta(x_t, t)$
5. Compute loss $\|\epsilon - \hat{\epsilon}\|^2$ and backpropagate

There is no adversarial training, no mode collapse, no training instability. The loss is a standard regression objective. This simplicity, combined with strong sample quality, is why diffusion models have largely replaced GANs.
</Remark>

## Score Matching

<Definition id="def-score-function" name="Score Function">
The **score function** of a distribution $p(x)$ is the gradient of the log-density:

$$s(x) = \nabla_x \log p(x)$$

Score matching [@hyvarinen2005estimation] trains a model $s_\theta(x) \approx \nabla_x \log p(x)$ without requiring the normalizing constant of $p$.
</Definition>

<Remark id="rmk-score-diffusion-connection">
**The score-diffusion connection.** The noise prediction $\epsilon_\theta$ and the score are related by:

<Equation id="eq-score-noise">

$$s_\theta(x_t, t) = \nabla_{x_t} \log q(x_t) \approx -\frac{\epsilon_\theta(x_t, t)}{\sqrt{1 - \bar{\alpha}_t}}$$

</Equation>

**Derivation.** Since $q(x_t|x_0) = \mathcal{N}(\sqrt{\bar{\alpha}_t}x_0, (1-\bar{\alpha}_t)I)$:

$$\nabla_{x_t} \log q(x_t|x_0) = -\frac{x_t - \sqrt{\bar{\alpha}_t}x_0}{1 - \bar{\alpha}_t} = -\frac{\epsilon}{\sqrt{1 - \bar{\alpha}_t}}$$

So training the noise predictor $\epsilon_\theta$ is equivalent to training a score estimator, up to a known scaling factor. This unifies DDPM with the score-based SDE framework of Song et al. [@song2021score].
</Remark>

<Remark id="rmk-score-equivalence">
**Three views of the same model:**

| View | Model outputs | Training loss | Sampling |
|------|--------------|---------------|----------|
| **Noise prediction** | $\epsilon_\theta(x_t, t) \approx \epsilon$ | $\|\epsilon - \epsilon_\theta\|^2$ | DDPM ancestral sampling |
| **Score estimation** | $s_\theta(x_t, t) \approx \nabla \log q_t$ | Denoising score matching | Langevin dynamics / probability flow ODE |
| **Denoising** | $\hat{x}_\theta(x_t, t) \approx x_0$ | $\|x_0 - \hat{x}_\theta\|^2$ (reweighted) | DDIM / flow matching |

All three are mathematically equivalent. The score/SDE perspective [@song2021score] generalizes discrete-time DDPM to continuous time, where the forward process is an SDE $dx = f(x,t)dt + g(t)dW$ and the reverse is $dx = [f - g^2 \nabla \log p_t]dt + g \, d\bar{W}$.
</Remark>

## Sampling Algorithms

<Table id="tab-sampling-algorithms" caption="Sampling algorithms for diffusion models.">

| Algorithm | Steps | Stochastic? | Key Idea |
|-----------|-------|-------------|----------|
| DDPM [@ho2020ddpm] | $T$ (1000) | Yes | Ancestral sampling; add noise at each step |
| DDIM [@song2021denoising] | $S \ll T$ | No (deterministic) | Skip steps via non-Markovian reverse; same training |
| DPM-Solver [@lu2022dpm] | 10-20 | No | High-order ODE solver for probability flow ODE |
| Euler (1st order) | 20-50 | Yes/No | Simplest discretization of the reverse SDE/ODE |
| Heun (2nd order) | 20-50 | No | Predictor-corrector; better quality per step |
| Consistency models [@song2023consistency] | 1-2 | No | Direct mapping from noise to data; distilled or trained |
| Rectified flow [@liu2023flow] | 1-few | No | Learn straight-line trajectories from noise to data |

</Table>

<Remark id="rmk-ddim">
**DDIM and the speed-quality tradeoff.** DDIM (Denoising Diffusion Implicit Models) [@song2021denoising] shows that the same trained model (same $\epsilon_\theta$) can be used with a *non-Markovian* reverse process that skips steps. By selecting a subsequence of $S$ timesteps from $\{1, \ldots, T\}$, DDIM generates samples in $S$ steps instead of $T$. The key insight: the forward marginals $q(x_t|x_0)$ are the same regardless of the reverse process structure, so we can use any reverse process consistent with these marginals.

Setting the stochasticity parameter $\eta = 0$ gives a fully deterministic ODE (the **probability flow ODE**), enabling exact likelihood computation and meaningful latent space interpolation.
</Remark>

## Classifier-Free Guidance

<Definition id="def-cfg" name="Classifier-Free Guidance">
**Classifier-free guidance** (CFG) [@ho2022cfg] combines conditional and unconditional predictions:

<Equation id="eq-cfg">

$$\tilde{\epsilon}_\theta(x_t, t, c) = (1 + w) \, \epsilon_\theta(x_t, t, c) - w \, \epsilon_\theta(x_t, t, \varnothing)$$

</Equation>

where $c$ is the conditioning signal (e.g., text prompt), $\varnothing$ is the null condition (trained by randomly dropping the condition during training with probability $p_{\text{uncond}} \approx 0.1$), and $w \geq 0$ is the **guidance scale**.
</Definition>

<Remark id="rmk-cfg-mechanism">
**CFG as implicit classifier guidance.** Rewriting the guided prediction in terms of scores:

$$\tilde{s}(x_t, t, c) = s(x_t, t) + (1+w) \cdot [s(x_t, t, c) - s(x_t, t)] = s(x_t, t) + (1+w) \nabla_{x_t} \log p(c|x_t)$$

This shows that CFG amplifies the implicit classifier gradient $\nabla \log p(c|x_t)$ by a factor of $(1+w)$, pushing samples toward higher conditional likelihood. The effect:

| $w$ | Behavior | Trade-off |
|-----|----------|-----------|
| $w = 0$ | Standard conditional model | Maximum diversity |
| $w = 1$-$3$ | Mild guidance | Good diversity-quality balance |
| $w = 5$-$15$ | Strong guidance (typical for image gen) | High quality, lower diversity |
| $w \to \infty$ | Approaches mode of $p(c|x_t)$ | Near-deterministic, possible artifacts |

Guidance is now standard in essentially all conditional diffusion models (Stable Diffusion, DALL-E, Imagen). The guidance scale is the primary user-facing quality knob.
</Remark>

## Latent Diffusion and Practical Architecture

<Remark id="rmk-latent-diffusion">
**Latent Diffusion Models (LDM)** [@rombach2022ldm] apply the diffusion process in a learned latent space rather than pixel space:

1. **Encode:** $z_0 = \mathcal{E}(x_0)$ using a pretrained VAE encoder ($256 \times 256 \times 3 \to 32 \times 32 \times 4$, typical $8\times$ compression).
2. **Diffuse:** Run forward/reverse process on $z_t$ instead of $x_t$.
3. **Decode:** $\hat{x}_0 = \mathcal{D}(\hat{z}_0)$ using the VAE decoder.

This reduces the dimensionality by $\sim 64\times$ (from $256^2 \times 3 = 196K$ to $32^2 \times 4 = 4K$), making the diffusion process dramatically cheaper while preserving perceptual quality. The denoising network is typically a **U-Net** with cross-attention layers for text conditioning, or more recently a **Diffusion Transformer (DiT)** [@peebles2023dit] that uses a standard Transformer architecture on patchified latents.
</Remark>

<Remark id="rmk-flow-matching">
**Flow matching** [@lipman2023flow] is a related framework that learns a velocity field $v_\theta(x_t, t)$ defining an ODE from noise to data: $dx/dt = v_\theta(x_t, t)$. Instead of the diffusion forward process, flow matching interpolates linearly: $x_t = (1-t)x_0 + t\epsilon$. The training loss is:

$$\mathcal{L} = \mathbb{E}_{t, x_0, \epsilon}\left[\|v_\theta(x_t, t) - (\epsilon - x_0)\|^2\right]$$

Flow matching produces straighter trajectories than diffusion, enabling fewer sampling steps. It has become the basis for several modern generative models (e.g., Stable Diffusion 3).
</Remark>

## Notation Summary

<Table id="tab-notation-diffusion" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $x_0$ | Clean data |
| $x_t$ | Noisy data at timestep $t$ |
| $\beta_t$ | Noise schedule at step $t$ |
| $\alpha_t = 1 - \beta_t$ | Signal retention per step |
| $\bar{\alpha}_t = \prod_{s \leq t}\alpha_s$ | Cumulative signal retention |
| $\text{SNR}(t) = \bar{\alpha}_t/(1-\bar{\alpha}_t)$ | Signal-to-noise ratio |
| $\epsilon$ | Gaussian noise added during forward process |
| $\epsilon_\theta$ | Neural network noise prediction |
| $s_\theta$ | Score function estimate: $\nabla \log p_t$ |
| $\hat{x}_\theta$ | Neural network clean data prediction |
| $v_\theta$ | Velocity prediction (flow matching) |
| $q(x_t|x_0)$ | Forward process marginal |
| $p_\theta(x_{t-1}|x_t)$ | Learned reverse process |
| $c$ | Conditioning signal (text, class label) |
| $w$ | Guidance scale (CFG) |
| $T$ | Number of diffusion steps |
| LDM | Latent diffusion model |
| DiT | Diffusion Transformer |

</Table>
