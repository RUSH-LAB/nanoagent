---
sidebar_position: 1
---

# Loss Functions

## Cross Entropy

<Definition id="def-entropy" name="Entropy">
The **entropy** of a distribution $p$ is $H(p) = -\sum_{x} p(x) \log p(x)$.
</Definition>

<Definition id="def-cross-entropy" name="Cross Entropy">
The **cross entropy** between a true distribution $p$ and a predicted distribution $q$ is:

<Equation id="eq-cross-entropy">

$$H(p, q) = -\sum_{x} p(x) \log q(x) = H(p) + D_{\text{KL}}(p \| q)$$

</Equation>
</Definition>

$H(p)$ depends only on the true data distribution $p$, not on any model parameters. Since we optimize over the model (which defines $q$), $H(p)$ is a fixed constant during training. Only the $D_{\text{KL}}$ term varies with $q$, so minimizing cross entropy is equivalent to minimizing KL divergence.

For classification with one-hot labels, this reduces to $\mathcal{L} = -\log \hat{y}_c$ where $c$ is the true class. The binary case ($K=2$) is:

<Equation id="eq-binary-cross-entropy">

$$\mathcal{L} = -\frac{1}{N} \sum_{i=1}^{N} \left[ y_i \log \hat{y}_i + (1 - y_i) \log (1 - \hat{y}_i) \right]$$

</Equation>

**When it is used:** standard loss for classification tasks (logistic regression, neural network classifiers, language model next-token prediction).

## KL Divergence

<Definition id="def-kl-divergence" name="Kullback-Leibler Divergence">
The **Kullback-Leibler divergence** measures how much one distribution $p$ differs from another $q$:

<Equation id="eq-kl-divergence">

$$D_{\text{KL}}(p \| q) = \sum_{x} p(x) \log \frac{p(x)}{q(x)} = \int p(x) \log \frac{p(x)}{q(x)} \, dx \quad \text{(continuous)}$$

</Equation>
</Definition>

**Is it symmetric?** No. $D_{\text{KL}}(p \| q) \neq D_{\text{KL}}(q \| p)$ in general, so it is not a true distance metric. The two directions have different behavior:

- **Forward KL** $D_{\text{KL}}(p \| q)$ -- mean-seeking: $q$ spreads to cover all modes of $p$.
- **Reverse KL** $D_{\text{KL}}(q \| p)$ -- mode-seeking: $q$ concentrates on a single mode of $p$.

**Key properties:** non-negative ($= 0$ iff $p = q$), not symmetric, does not satisfy triangle inequality, additive for independent variables.

<Example id="ex-kl-gaussian">
**Closed form for Gaussians:** for $p = \mathcal{N}(\mu_1, \sigma_1^2)$ and $q = \mathcal{N}(\mu_2, \sigma_2^2)$:

<Equation id="eq-kl-gaussian">

$$D_{\text{KL}}(p \| q) = \log \frac{\sigma_2}{\sigma_1} + \frac{\sigma_1^2 + (\mu_1 - \mu_2)^2}{2\sigma_2^2} - \frac{1}{2}$$

</Equation>
</Example>

**When it is used:** VAE regularization (matching the encoder posterior to a prior) [@kingma2014vae], knowledge distillation (matching a student network to a teacher) [@hinton2015distilling], reinforcement learning (PPO's clipped objective constrains policy updates via KL) [@schulman2017ppo], and RLHF (penalizing drift from a reference policy) [@ouyang2022training].

## Notation Summary

<Table id="tab-notation-loss" caption="Notation used in loss functions.">

| Symbol | Meaning |
|---|---|
| $p$ | True (data) distribution |
| $q$ | Model (predicted) distribution |
| $H(p)$ | Entropy of $p$ |
| $H(p, q)$ | Cross entropy between $p$ and $q$ |
| $D_{\text{KL}}(p \| q)$ | KL divergence from $q$ to $p$ |
| $\hat{y}_c$ | Predicted probability for true class $c$ |
| $y_i$ | Ground-truth label for sample $i$ |
| $N$ | Number of samples |
| $K$ | Number of classes |
| $\mathcal{L}$ | Loss value |

</Table>
