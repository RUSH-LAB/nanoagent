---
sidebar_position: 2
---

# Distributions

## Discrete Distributions

<Definition id="def-bernoulli" name="Bernoulli Distribution">
**Bernoulli** -- single binary trial with success probability $p$:

<Equation id="eq-bernoulli">

$$P(X = x) = p^x (1-p)^{1-x}, \quad x \in \{0, 1\}$$

</Equation>

$\mathbb{E}[X] = p$, $\text{Var}(X) = p(1-p)$.
</Definition>

<Definition id="def-categorical" name="Categorical Distribution">
**Categorical** -- generalization to $K$ classes with probabilities $\pi = (\pi_1, \dots, \pi_K)$:

$$
P(X = k) = \pi_k, \quad \sum_{k=1}^K \pi_k = 1
$$
</Definition>

**Binomial** -- number of successes in $n$ independent Bernoulli trials:

$$
P(X = k) = \binom{n}{k} p^k (1-p)^{n-k}
$$

<Remark id="rmk-categorical-softmax">
The Categorical distribution is the output distribution for classification. The softmax function converts logits $z \in \mathbb{R}^K$ to a Categorical distribution: $\pi_k = \frac{e^{z_k}}{\sum_j e^{z_j}}$.
</Remark>

## The Gaussian Distribution

<Definition id="def-gaussian" name="Gaussian Distribution">
The **univariate Gaussian** (normal) distribution with mean $\mu$ and variance $\sigma^2$:

<Equation id="eq-gaussian-univariate">

$$p(x) = \frac{1}{\sqrt{2\pi\sigma^2}} \exp\left(-\frac{(x - \mu)^2}{2\sigma^2}\right)$$

</Equation>

The **multivariate Gaussian** for $x \in \mathbb{R}^n$ with mean $\mu$ and covariance matrix $\Sigma$:

<Equation id="eq-gaussian-multivariate">

$$p(x) = \frac{1}{(2\pi)^{n/2} |\Sigma|^{1/2}} \exp\left(-\frac{1}{2}(x - \mu)^\top \Sigma^{-1}(x - \mu)\right)$$

</Equation>
</Definition>

Properties of the multivariate Gaussian:

<Table id="tab-gaussian-props" caption="Closure properties of the multivariate Gaussian.">

| Property | Formula |
|----------|---------|
| Marginal | $p(x_A) = \mathcal{N}(\mu_A, \Sigma_{AA})$ |
| Conditional | $p(x_A | x_B) = \mathcal{N}(\mu_{A|B}, \Sigma_{A|B})$ |
| Sum | $X + Y \sim \mathcal{N}(\mu_X + \mu_Y, \Sigma_X + \Sigma_Y)$ if independent |
| Linear transform | $AX \sim \mathcal{N}(A\mu, A\Sigma A^\top)$ |

</Table>

<Remark id="rmk-gaussian-central">
The Gaussian distribution is central to ML because (1) it maximizes entropy for a given mean and variance, (2) the central limit theorem makes it a natural model for sums of independent variables, and (3) it is closed under linear transformations and conditioning.
</Remark>

## Softmax Distribution

<Definition id="def-softmax" name="Softmax Function">
The **softmax function** maps logits $z \in \mathbb{R}^K$ to a probability distribution:

<Equation id="eq-softmax-dist">

$$\text{softmax}(z)_k = \frac{e^{z_k}}{\sum_{j=1}^K e^{z_j}}$$

</Equation>

With **temperature** $\tau$: $\text{softmax}(z/\tau)_k$. As $\tau \to 0$, the distribution approaches argmax (deterministic). As $\tau \to \infty$, it approaches uniform.
</Definition>

## Mixture Models

<Definition id="def-gmm" name="Gaussian Mixture Model">
A **Gaussian mixture model** (GMM) combines $K$ Gaussian components:

<Equation id="eq-gmm">

$$p(x) = \sum_{k=1}^K \pi_k \, \mathcal{N}(x | \mu_k, \Sigma_k)$$

</Equation>

where $\pi_k$ are mixing weights ($\sum_k \pi_k = 1$). GMMs can approximate any continuous density (universal approximation for densities).
</Definition>

<Remark id="rmk-latent-variable">
Mixture models introduce a latent variable $z$ (the component assignment). The marginal $p(x) = \sum_z p(x|z)p(z)$ integrates over the latent. This is the same structure as VAEs [@kingma2014vae] (continuous latent) and diffusion models [@ho2020ddpm] (chain of latents).
</Remark>

## Notation Summary

<Table id="tab-notation-dist" caption="Notation used in distributions.">

| Symbol | Meaning |
|--------|---------|
| $p, \pi$ | Probability / mixing weight |
| $\mu$ | Mean (scalar or vector) |
| $\sigma^2, \Sigma$ | Variance (scalar) / covariance (matrix) |
| $\mathcal{N}(\mu, \Sigma)$ | Gaussian distribution |
| $\tau$ | Temperature parameter |
| $K$ | Number of classes or mixture components |
| $z$ | Logits or latent variable |

</Table>
