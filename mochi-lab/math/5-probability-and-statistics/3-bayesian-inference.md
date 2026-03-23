---
sidebar_position: 3
---

# Bayesian Inference

## The Bayesian Framework

<Definition id="def-bayesian-inference" name="Bayesian Inference">
Given data $\mathcal{D}$ and model parameters $\theta$, Bayesian inference computes the posterior:

<Equation id="eq-posterior">

$$p(\theta | \mathcal{D}) = \frac{p(\mathcal{D} | \theta) \, p(\theta)}{p(\mathcal{D})} = \frac{p(\mathcal{D} | \theta) \, p(\theta)}{\int p(\mathcal{D} | \theta') \, p(\theta') \, d\theta'}$$

</Equation>
</Definition>

<Table id="tab-bayesian-terms" caption="Components of Bayesian inference.">

| Term | Name | Role |
|------|------|------|
| $p(\theta)$ | Prior | Belief about $\theta$ before seeing data |
| $p(\mathcal{D} \| \theta)$ | Likelihood | How likely the data is given $\theta$ |
| $p(\theta \| \mathcal{D})$ | Posterior | Updated belief after seeing data |
| $p(\mathcal{D})$ | Evidence (marginal likelihood) | Normalizing constant |

</Table>

## MLE vs MAP

<Definition id="def-mle" name="Maximum Likelihood Estimation">
**Maximum Likelihood Estimation (MLE)** ignores the prior:

<Equation id="eq-mle">

$$\theta_{\text{MLE}} = \arg\max_\theta p(\mathcal{D} | \theta) = \arg\max_\theta \sum_{i=1}^N \log p(x_i | \theta)$$

</Equation>
</Definition>

<Definition id="def-map" name="Maximum A Posteriori Estimation">
**Maximum A Posteriori (MAP)** includes the prior:

<Equation id="eq-map">

$$\theta_{\text{MAP}} = \arg\max_\theta p(\theta | \mathcal{D}) = \arg\max_\theta \left[\log p(\mathcal{D} | \theta) + \log p(\theta)\right]$$

</Equation>
</Definition>

<Remark id="rmk-map-regularization">
MAP with a Gaussian prior $p(\theta) \propto e^{-\lambda\|\theta\|^2/2}$ is exactly L2-regularized MLE. MAP with a Laplace prior gives L1 regularization. The regularization coefficient $\lambda$ is the precision (inverse variance) of the prior.
</Remark>

## Conjugate Priors

<Definition id="def-conjugate-prior" name="Conjugate Prior">
A prior $p(\theta)$ is **conjugate** to a likelihood $p(\mathcal{D}|\theta)$ if the posterior has the same functional form as the prior.
</Definition>

<Table id="tab-conjugate-priors" caption="Common conjugate prior-likelihood pairs.">

| Likelihood | Conjugate Prior | Posterior |
|------------|----------------|-----------|
| Bernoulli | Beta$(\alpha, \beta)$ | Beta$(\alpha + k, \beta + n - k)$ |
| Gaussian (known $\sigma$) | Gaussian | Gaussian |
| Categorical | Dirichlet | Dirichlet |
| Poisson | Gamma | Gamma |

</Table>

Conjugate priors allow closed-form posterior updates, avoiding expensive numerical integration.

## Approximate Inference

For most models, the posterior $p(\theta|\mathcal{D})$ is intractable (the integral in the denominator cannot be computed in closed form). Two main approximation strategies:

<Definition id="def-vi" name="Variational Inference">
**Variational Inference (VI):** Approximate the posterior with a tractable distribution $q_\phi(\theta)$ by minimizing the KL divergence:

$$
\phi^* = \arg\min_\phi D_{\text{KL}}(q_\phi(\theta) \| p(\theta | \mathcal{D}))
$$

This is equivalent to maximizing the **Evidence Lower Bound (ELBO)**:

<Equation id="eq-elbo">

$$\text{ELBO} = \mathbb{E}_{q_\phi}[\log p(\mathcal{D} | \theta)] - D_{\text{KL}}(q_\phi(\theta) \| p(\theta)) \leq \log p(\mathcal{D})$$

</Equation>
</Definition>

**Markov Chain Monte Carlo (MCMC):** Draw samples from the posterior by constructing a Markov chain whose stationary distribution is $p(\theta|\mathcal{D})$. Exact in the limit of infinite samples but slow in practice.

## ML Connections

<Table id="tab-bayesian-ml" caption="Bayesian components in modern ML models.">

| Model | Bayesian Component |
|-------|--------------------|
| **VAE** | Encoder $q_\phi(z|x)$ approximates posterior $p(z|x)$; ELBO is the training objective |
| **Bayesian NN** | Place prior over weights; posterior gives uncertainty estimates |
| **GPT pretraining** | MLE over token sequences: $\max \sum_t \log p(x_t | x_{<t}; \theta)$ |
| **Diffusion models** | Variational bound on log-likelihood; forward process defines the prior |

</Table>

<Remark id="rmk-elbo-tradeoff">
The ELBO decomposes into a reconstruction term (fit the data) and a KL regularization term (stay close to the prior). This tradeoff between data fit and simplicity is the Bayesian analogue of the bias-variance tradeoff.
</Remark>

## Notation Summary

<Table id="tab-notation-bayesian" caption="Notation used in Bayesian inference.">

| Symbol | Meaning |
|--------|---------|
| $\theta$ | Model parameters |
| $\mathcal{D}$ | Observed data |
| $p(\theta)$ | Prior distribution |
| $p(\mathcal{D}|\theta)$ | Likelihood |
| $p(\theta|\mathcal{D})$ | Posterior distribution |
| $q_\phi(\theta)$ | Variational approximation to the posterior |
| ELBO | Evidence lower bound |
| MLE | Maximum likelihood estimation |
| MAP | Maximum a posteriori estimation |

</Table>
