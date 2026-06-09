---
sidebar_position: 1
---

# Loss Functions

A loss function $\ell: \hat{\mathcal{Y}} \times \mathcal{Y} \to \mathbb{R}$ maps a prediction and a ground truth to a scalar measuring how wrong the prediction is. The choice of loss function encodes our assumptions about the task, the noise model, and what "good performance" means.

## Cross Entropy

<Definition id="def-entropy" name="Entropy">
The **entropy** of a discrete distribution $p$ is:

<Equation id="eq-entropy">

$$H(p) = -\sum_{x} p(x) \log p(x) = \mathbb{E}_{x \sim p}\left[-\log p(x)\right]$$

</Equation>

Entropy measures the average surprise (in nats if using $\ln$, or bits if using $\log_2$) of observing samples from $p$. It is maximized by the uniform distribution and equals zero only for a deterministic distribution.
</Definition>

<Definition id="def-cross-entropy" name="Cross Entropy">
The **cross entropy** between a true distribution $p$ and a predicted distribution $q$ is:

<Equation id="eq-cross-entropy">

$$H(p, q) = -\sum_{x} p(x) \log q(x) = H(p) + D_{\text{KL}}(p \| q)$$

</Equation>
</Definition>

The decomposition $H(p,q) = H(p) + D_{\text{KL}}(p \| q)$ is key. $H(p)$ depends only on the true data distribution, which is fixed during training. Since we optimize over the model (which defines $q$), only the $D_{\text{KL}}$ term varies with model parameters. Therefore **minimizing cross entropy is equivalent to minimizing the KL divergence** $D_{\text{KL}}(p \| q)$ (the divergence from the true distribution $p$ to the model distribution $q$).

<Example id="ex-cross-entropy-classification">
**One-hot classification.** For a classification problem with $K$ classes, the true label for sample $i$ is a one-hot vector $p = e_c$ (all zeros except position $c$). The cross entropy reduces to:

$$\mathcal{L} = -\sum_{k=1}^K p_k \log q_k = -\log q_c$$

where $q_c = \hat{y}_c$ is the model's predicted probability for the true class. This is the **negative log-likelihood** of the correct class.
</Example>

For **binary classification** ($K=2$), the full loss averaged over $N$ samples is:

<Equation id="eq-binary-cross-entropy">

$$\mathcal{L}_{\text{BCE}} = -\frac{1}{N} \sum_{i=1}^{N} \left[ y_i \log \hat{y}_i + (1 - y_i) \log (1 - \hat{y}_i) \right]$$

</Equation>

where $y_i \in \{0, 1\}$ and $\hat{y}_i = \sigma(z_i) \in (0, 1)$ is the sigmoid output.

<Remark id="rmk-cross-entropy-gradient">
**Gradient simplicity.** The gradient of cross-entropy loss composed with softmax has a remarkably clean form. For logits $z \in \mathbb{R}^K$ and softmax output $\hat{y} = \text{softmax}(z)$:

$$\frac{\partial \mathcal{L}}{\partial z_k} = \hat{y}_k - \mathbf{1}[k = c]$$

This is simply the predicted probability minus the one-hot target. No derivatives of log or softmax appear explicitly, because they cancel. This cancellation also improves numerical stability, which is why `F.cross_entropy` in PyTorch takes raw logits, not probabilities.
</Remark>

**When it is used:** Standard loss for classification tasks (logistic regression, neural network classifiers, language model next-token prediction). For language models, the loss is averaged over all tokens in a sequence: $\mathcal{L} = -\frac{1}{T}\sum_{t=1}^T \log P(x_t | x_{<t})$.

## KL Divergence

<Definition id="def-kl-divergence" name="Kullback-Leibler Divergence">
The **Kullback-Leibler divergence** measures how much one distribution $p$ differs from another $q$:

<Equation id="eq-kl-divergence">

$$D_{\text{KL}}(p \| q) = \sum_{x} p(x) \log \frac{p(x)}{q(x)} = \mathbb{E}_{x \sim p}\left[\log \frac{p(x)}{q(x)}\right]$$

</Equation>

For continuous distributions:

$$D_{\text{KL}}(p \| q) = \int p(x) \log \frac{p(x)}{q(x)} \, dx$$

</Definition>

### Key Properties

1. **Non-negativity (Gibbs' inequality):** $D_{\text{KL}}(p \| q) \geq 0$ with equality iff $p = q$ almost everywhere. This follows from Jensen's inequality applied to the concave function $\log$.
2. **Asymmetry:** $D_{\text{KL}}(p \| q) \neq D_{\text{KL}}(q \| p)$ in general. Therefore KL divergence is not a metric (it also fails the triangle inequality).
3. **Additivity:** For independent variables, $D_{\text{KL}}(p_1 p_2 \| q_1 q_2) = D_{\text{KL}}(p_1 \| q_1) + D_{\text{KL}}(p_2 \| q_2)$.
4. **Invariance under reparameterization:** KL divergence is unchanged by invertible transformations of the random variable.

### Forward vs. Reverse KL

The asymmetry of KL divergence has profound consequences for learning:

<Table id="tab-kl-directions" caption="Behavioral difference between forward and reverse KL divergence.">

| Direction | Name | Behavior | $q$ where $p > 0$ but $q \approx 0$ | Result |
|-----------|------|----------|--------------------------------------|--------|
| $D_{\text{KL}}(p \| q)$ | Forward KL | Mean-seeking | Infinite penalty | $q$ covers all modes of $p$ |
| $D_{\text{KL}}(q \| p)$ | Reverse KL | Mode-seeking | No penalty | $q$ locks onto one mode of $p$ |

</Table>

<Remark id="rmk-kl-directions-ml">
**Forward KL** ($D_{\text{KL}}(p \| q)$) is what we minimize when we train by maximum likelihood (cross-entropy). It forces $q$ to spread mass everywhere $p$ has mass, which can produce overly diffuse predictions when $p$ is multimodal.

**Reverse KL** ($D_{\text{KL}}(q \| p)$) is what variational inference minimizes (the ELBO). It allows $q$ to ignore modes of $p$, producing sharper but potentially incomplete approximations. This is why variational autoencoders sometimes suffer from "mode collapse."
</Remark>

<Example id="ex-kl-gaussian">
**Closed form for Gaussians.** For $p = \mathcal{N}(\mu_1, \sigma_1^2)$ and $q = \mathcal{N}(\mu_2, \sigma_2^2)$:

<Equation id="eq-kl-gaussian">

$$D_{\text{KL}}(p \| q) = \log \frac{\sigma_2}{\sigma_1} + \frac{\sigma_1^2 + (\mu_1 - \mu_2)^2}{2\sigma_2^2} - \frac{1}{2}$$

</Equation>

For multivariate Gaussians $p = \mathcal{N}(\mu_1, \Sigma_1)$ and $q = \mathcal{N}(\mu_2, \Sigma_2)$:

$$D_{\text{KL}}(p \| q) = \frac{1}{2}\left[\log\frac{|\Sigma_2|}{|\Sigma_1|} - d + \text{tr}(\Sigma_2^{-1}\Sigma_1) + (\mu_2 - \mu_1)^\top \Sigma_2^{-1}(\mu_2 - \mu_1)\right]$$

where $d$ is the dimensionality. This is used in the VAE loss, where we measure $D_{\text{KL}}(p \| q)$ with $p$ being the encoder posterior and $q = \mathcal{N}(0, I)$ being the prior (note the role swap: here $p$ is the approximate posterior, inverting the notation convention from the chapter summary).
</Example>

**When it is used:** VAE regularization (matching the encoder posterior to a prior) [@kingma2014vae], knowledge distillation (matching a student network's output distribution to a teacher's) [@hinton2015distilling], reinforcement learning (PPO's clipped objective constrains policy updates; RLHF penalizes drift from a reference policy) [@schulman2017ppo; @ouyang2022training].

## Mean Squared Error and Regression Losses

<Definition id="def-mse" name="Mean Squared Error">
For regression with continuous targets $y_i \in \mathbb{R}$:

<Equation id="eq-mse">

$$\mathcal{L}_{\text{MSE}} = \frac{1}{N} \sum_{i=1}^{N} (y_i - \hat{y}_i)^2$$

</Equation>
</Definition>

<Remark id="rmk-mse-gaussian">
MSE is the maximum likelihood loss under the assumption that $y = f(x) + \epsilon$ where $\epsilon \sim \mathcal{N}(0, \sigma^2)$. The negative log-likelihood of $y | x$ under this model is $\frac{1}{2\sigma^2}(y - f(x))^2 + \text{const}$, which is proportional to MSE.
</Remark>

<Table id="tab-regression-losses" caption="Common regression losses and their properties.">

| Loss | Formula | Gradient | Properties |
|------|---------|----------|------------|
| MSE (L2) | $(y - \hat{y})^2$ | $2(\hat{y} - y)$ | Sensitive to outliers; smooth everywhere |
| MAE (L1) | $|y - \hat{y}|$ | $\text{sign}(\hat{y} - y)$ | Robust to outliers; non-smooth at 0 |
| Huber | $\begin{cases} \frac{1}{2}(y-\hat{y})^2 & |y-\hat{y}| \leq \delta \\ \delta(|y-\hat{y}| - \frac{\delta}{2}) & \text{otherwise}\end{cases}$ | Quadratic near 0, linear far | Smooth and robust |
| Log-cosh | $\log \cosh(y - \hat{y})$ | $\tanh(\hat{y} - y)$ | Twice-differentiable Huber approximation |

</Table>

## Contrastive and Ranking Losses

<Definition id="def-triplet-loss" name="Triplet Loss">
Given an anchor $a$, a positive $p$ (same class), and a negative $n$ (different class):

<Equation id="eq-triplet-loss">

$$\mathcal{L}_{\text{triplet}} = \max\!\left(0, \; \|f(a) - f(p)\|^2 - \|f(a) - f(n)\|^2 + \alpha\right)$$

</Equation>

where $\alpha > 0$ is the margin. The loss pushes the anchor closer to the positive and farther from the negative in embedding space.
</Definition>

<Definition id="def-infonce" name="InfoNCE Loss">
The contrastive loss used in CLIP [@radford2021clip], SimCLR [@chen2020simclr], and similar frameworks:

<Equation id="eq-infonce">

$$\mathcal{L}_{\text{InfoNCE}} = -\log \frac{\exp(f(x)^\top f(x^+) / \tau)}{\sum_{j=1}^{K} \exp(f(x)^\top f(x_j) / \tau)}$$

</Equation>

where $x^+$ is the positive pair, $\{x_j\}$ includes the positive and $K-1$ negatives, and $\tau > 0$ is the temperature. This is a softmax cross-entropy over similarity scores.
</Definition>

<Remark id="rmk-infonce-mi">
InfoNCE is a lower bound on mutual information: $\mathcal{L}_{\text{InfoNCE}} \geq -I(X; X^+) + \log K$ [@oord2018infonce]. More negatives ($K$) give a tighter bound but require more computation.
</Remark>

## Loss Functions in Practice

<Table id="tab-loss-usage" caption="Standard loss functions by ML task.">

| Task | Loss | Output Activation | PyTorch |
|------|------|-------------------|---------|
| Multi-class classification | Cross entropy | Softmax (implicit) | `F.cross_entropy(logits, labels)` |
| Binary classification | Binary cross entropy | Sigmoid | `F.binary_cross_entropy_with_logits` |
| Regression | MSE | None (linear) | `F.mse_loss` |
| Robust regression | Huber | None | `F.smooth_l1_loss` |
| Language modeling | Cross entropy (per token) | Softmax | `F.cross_entropy(logits.view(-1, V), labels.view(-1))` |
| Object detection | Focal loss + L1/GIoU | Sigmoid + linear | Custom |
| Contrastive learning | InfoNCE | Cosine similarity | Custom |
| VAE | Reconstruction + KL | Task-dependent + Gaussian | Custom |

</Table>

<Remark id="rmk-label-smoothing">
**Label smoothing** [@szegedy2016rethinking] replaces hard one-hot labels $p = e_c$ with smoothed labels $p_k = (1-\epsilon)\mathbf{1}[k=c] + \epsilon/K$, where $\epsilon$ is typically $0.1$. This prevents the model from becoming overconfident (logits $\to \pm\infty$) and acts as a form of regularization. It is equivalent to adding a small amount of KL divergence toward the uniform distribution.
</Remark>

## Notation Summary

<Table id="tab-notation-loss" caption="Notation used in this chapter.">

| Symbol | Meaning |
|---|---|
| $p$ | True (data) distribution |
| $q$ | Model (predicted) distribution |
| $H(p)$ | Entropy of $p$ |
| $H(p, q)$ | Cross entropy between $p$ and $q$ |
| $D_{\text{KL}}(p \| q)$ | KL divergence from $p$ to $q$ (first argument $p$ is the reference distribution; measures how much $p$ differs from $q$) |
| $\hat{y}_c$ | Predicted probability for true class $c$ |
| $y_i$ | Ground-truth label for sample $i$ |
| $N$ | Number of samples |
| $K$ | Number of classes |
| $T$ | Sequence length |
| $\tau$ | Temperature parameter |
| $\mathcal{L}$ | Loss value |
| $\sigma(\cdot)$ | Sigmoid function |

</Table>
