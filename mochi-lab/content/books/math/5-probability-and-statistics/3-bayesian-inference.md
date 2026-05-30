---
sidebar_position: 3
---

# Bayesian Inference

Bayesian inference is the principled framework for updating beliefs in light of evidence. While most deep learning uses point estimation (MLE/MAP), the Bayesian perspective illuminates *why* regularization works, provides calibrated uncertainty estimates, and underpins generative models from VAEs to diffusion models. Understanding the Bayesian framework is essential even if you never compute a full posterior.

## The Bayesian Framework

<Definition id="def-bayesian-inference" name="Bayesian Inference">
Given data $\mathcal{D}$ and model parameters $\theta$, Bayesian inference computes the **posterior distribution** via Bayes' theorem:

<Equation id="eq-posterior">

$$p(\theta | \mathcal{D}) = \frac{p(\mathcal{D} | \theta) \, p(\theta)}{p(\mathcal{D})} = \frac{p(\mathcal{D} | \theta) \, p(\theta)}{\int p(\mathcal{D} | \theta') \, p(\theta') \, d\theta'}$$

</Equation>

The posterior encodes everything we know about $\theta$ after observing $\mathcal{D}$. It is a complete description of parameter uncertainty, not just a point estimate.
</Definition>

<Table id="tab-bayesian-terms" caption="Components of Bayesian inference.">

| Term | Name | Role | ML Analogy |
|------|------|------|------------|
| $p(\theta)$ | Prior | Belief about $\theta$ before seeing data | Regularization (L2 = Gaussian prior) |
| $p(\mathcal{D} \| \theta)$ | Likelihood | How likely the data is given $\theta$ | Training loss (negative log-likelihood) |
| $p(\theta \| \mathcal{D})$ | Posterior | Updated belief after seeing data | The full "answer" to learning |
| $p(\mathcal{D})$ | Evidence (marginal likelihood) | Normalizing constant; model quality | Model selection criterion |

</Table>

<Remark id="rmk-bayesian-prediction">
**Bayesian prediction.** Given a new input $x_*$, the Bayesian predictive distribution integrates over parameter uncertainty:

$$p(y_* | x_*, \mathcal{D}) = \int p(y_* | x_*, \theta) \, p(\theta | \mathcal{D}) \, d\theta$$

This is a weighted average of predictions from all plausible parameter values, weighted by their posterior probability. The predictive distribution is wider (more uncertain) when the posterior is broad (little data) and narrower when the posterior is concentrated (lots of data). Point estimates (MLE/MAP) use a single $\theta^*$ and underestimate uncertainty.
</Remark>

<Remark id="rmk-bayesian-update">
**Sequential Bayesian updating.** Bayesian inference is inherently sequential: the posterior from one batch of data becomes the prior for the next. The factorization below relies on the likelihood splitting as $p(\mathcal{D}_1, \mathcal{D}_2 | \theta) = p(\mathcal{D}_1 | \theta) \, p(\mathcal{D}_2 | \theta)$, which holds when $\mathcal{D}_1$ and $\mathcal{D}_2$ are conditionally independent given $\theta$ (the standard i.i.d. assumption). Under that assumption, for data $\mathcal{D} = \mathcal{D}_1 \cup \mathcal{D}_2$:

$$p(\theta | \mathcal{D}_1, \mathcal{D}_2) \propto p(\mathcal{D}_2 | \theta) \cdot \underbrace{p(\theta | \mathcal{D}_1)}_{\text{new prior}}$$

This means the final posterior is independent of the order in which data arrives: only the total data matters. Online learning algorithms that update parameters incrementally can be seen as approximations to sequential Bayesian updating.
</Remark>

## MLE vs MAP vs Full Bayesian

<Definition id="def-mle" name="Maximum Likelihood Estimation">
**Maximum Likelihood Estimation (MLE)** finds the parameters that maximize the likelihood, ignoring the prior entirely:

<Equation id="eq-mle">

$$\theta_{\text{MLE}} = \arg\max_\theta p(\mathcal{D} | \theta) = \arg\max_\theta \sum_{i=1}^N \log p(x_i | \theta)$$

</Equation>

MLE is consistent (converges to the true parameter as $n \to \infty$) and asymptotically efficient (achieves the Cramér-Rao lower bound). However, it can overfit with finite data and provides no uncertainty estimates.
</Definition>

<Definition id="def-map" name="Maximum A Posteriori Estimation">
**Maximum A Posteriori (MAP)** estimation finds the mode of the posterior:

<Equation id="eq-map">

$$\theta_{\text{MAP}} = \arg\max_\theta p(\theta | \mathcal{D}) = \arg\max_\theta \left[\log p(\mathcal{D} | \theta) + \log p(\theta)\right]$$

</Equation>

MAP adds a regularization term $\log p(\theta)$ to the MLE objective. It is a point estimate that uses the prior but still discards the shape of the posterior.
</Definition>

<Table id="tab-estimation-comparison" caption="Comparison of estimation methods.">

| Method | Objective | Regularization | Uncertainty | Computation |
|--------|-----------|---------------|-------------|-------------|
| MLE | $\max \log p(\mathcal{D}|\theta)$ | None | No | Single optimization |
| MAP | $\max \log p(\mathcal{D}|\theta) + \log p(\theta)$ | Via prior | No | Single optimization |
| Full Bayesian | Compute $p(\theta|\mathcal{D})$ | Automatic | Yes | Integration (expensive) |
| Ensemble | Train $M$ models, average predictions | Implicit (diversity) | Approximate | $M \times$ training cost |
| MC Dropout | Average predictions with dropout on | Implicit (dropout) | Approximate | $M \times$ forward passes |

</Table>

<Remark id="rmk-map-regularization">
**MAP and regularization are the same thing.** The choice of prior determines the regularizer:

| Prior $p(\theta)$ | $-\log p(\theta)$ Penalty | Regularization |
|-------------------|--------------------------|----------------|
| $\mathcal{N}(0, 1/\lambda)$ | $\frac{\lambda}{2}\|\theta\|_2^2 + \text{const}$ | L2 (weight decay) |
| $\text{Laplace}(0, 1/\lambda)$ | $\lambda\|\theta\|_1 + \text{const}$ | L1 (sparsity) |
| $\text{Horseshoe}$ | Adaptive shrinkage | Sparse Bayesian learning |
| Uniform (improper) | $0$ | No regularization (= MLE) |

The regularization coefficient $\lambda$ is the precision (inverse variance) of the prior. Larger $\lambda$ means a more informative (tighter) prior, corresponding to stronger regularization.
</Remark>

## Conjugate Priors

<Definition id="def-conjugate-prior" name="Conjugate Prior">
A prior $p(\theta)$ is **conjugate** to a likelihood $p(\mathcal{D}|\theta)$ if the posterior $p(\theta|\mathcal{D})$ has the same functional form as the prior. Formally, the prior family is closed under Bayesian updating with the given likelihood.
</Definition>

<Table id="tab-conjugate-priors" caption="Common conjugate prior-likelihood pairs.">

| Likelihood | Conjugate Prior | Posterior | Posterior Parameters |
|------------|----------------|-----------|---------------------|
| Bernoulli($p$) | Beta$(\alpha, \beta)$ | Beta$(\alpha', \beta')$ | $\alpha' = \alpha + \sum x_i$, $\beta' = \beta + n - \sum x_i$ |
| Categorical($\pi$) | Dirichlet$(\alpha)$ | Dirichlet$(\alpha')$ | $\alpha_k' = \alpha_k + n_k$ (count of class $k$) |
| Gaussian($\mu$, known $\sigma^2$) | Gaussian$(\mu_0, \sigma_0^2)$ | Gaussian$(\mu_n, \sigma_n^2)$ | Precision-weighted mean; $\sigma_n^{-2} = \sigma_0^{-2} + n/\sigma^2$ |
| Gaussian($\sigma^2$, known $\mu$) | Inv-Gamma$(\alpha, \beta)$ | Inv-Gamma$(\alpha', \beta')$ | $\alpha' = \alpha + n/2$, $\beta' = \beta + \frac{1}{2}\sum(x_i - \mu)^2$ |
| Poisson($\lambda$) | Gamma$(\alpha, \beta)$ | Gamma$(\alpha', \beta')$ | $\alpha' = \alpha + \sum x_i$, $\beta' = \beta + n$ |
| Multinomial | Dirichlet | Dirichlet | Counts added to pseudocounts |

</Table>

<Remark id="rmk-conjugate-intuition">
**Interpreting conjugate prior parameters.** The prior hyperparameters can be interpreted as "pseudo-observations":

- **Beta$(\alpha, \beta)$ prior for Bernoulli:** Acts like having already seen $\alpha - 1$ successes and $\beta - 1$ failures. The prior strength is $\alpha + \beta$ (total pseudo-count).
- **Dirichlet$(\alpha)$ prior for Categorical:** Acts like having seen $\alpha_k - 1$ examples of class $k$. Uniform prior: $\alpha_k = 1$. Laplace smoothing: $\alpha_k = 2$ (adds 1 to each count).
- **Gaussian prior for Gaussian mean:** The posterior mean is a precision-weighted average of the prior mean and sample mean: $\mu_n = \frac{\sigma_0^{-2} \mu_0 + (n/\sigma^2)\bar{x}}{\sigma_0^{-2} + n/\sigma^2}$. As $n \to \infty$, the posterior concentrates on $\bar{x}$ (data overwhelms the prior).
</Remark>

<Example id="ex-beta-bernoulli">
**Beta-Bernoulli posterior update (worked step by step).** Suppose we model whether a coin lands heads with probability $p$, and we place a prior $\text{Beta}(\alpha, \beta) = \text{Beta}(2, 2)$ (a weak belief that $p$ is near $0.5$, equivalent to having already seen one head and one tail). We then flip the coin $n = 10$ times and observe $\sum_i x_i = 8$ heads.

**Step 1: Apply the conjugate update rule.** From the Bernoulli-Beta row of the table, $\alpha' = \alpha + \sum_i x_i$ and $\beta' = \beta + n - \sum_i x_i$:

$$\alpha' = 2 + 8 = 10, \qquad \beta' = 2 + (10 - 8) = 4.$$

So the posterior is $\text{Beta}(10, 4)$.

**Step 2: Summarize the posterior.** The mean of a $\text{Beta}(\alpha', \beta')$ distribution is $\frac{\alpha'}{\alpha' + \beta'}$:

$$\mathbb{E}[p \mid \mathcal{D}] = \frac{10}{10 + 4} = \frac{10}{14} \approx 0.714.$$

Note this is pulled below the raw maximum-likelihood estimate $\frac{8}{10} = 0.8$: the prior, acting like two extra pseudo-observations split evenly, shrinks the estimate toward $0.5$. As we collect more data, the pseudo-counts become negligible and the posterior mean approaches the empirical frequency.
</Example>

<Example id="ex-gaussian-mean">
**Gaussian-mean precision-weighted update (faded guidance).** Now estimate the unknown mean $\mu$ of a Gaussian with known variance $\sigma^2 = 4$. Place the prior $\mathcal{N}(\mu_0, \sigma_0^2) = \mathcal{N}(0, 1)$, then observe $n = 10$ points with sample mean $\bar{x} = 3$.

First combine precisions, $\sigma_n^{-2} = \sigma_0^{-2} + n/\sigma^2 = 1 + 10/4 = 3.5$, so the posterior variance is $\sigma_n^2 = 1/3.5 \approx 0.286$. Then form the precision-weighted mean:

$$\mu_n = \frac{\sigma_0^{-2}\mu_0 + (n/\sigma^2)\bar{x}}{\sigma_0^{-2} + n/\sigma^2} = \frac{(1)(0) + (10/4)(3)}{3.5} = \frac{7.5}{3.5} \approx 2.143.$$

The posterior $\mathcal{N}(2.143, 0.286)$ sits between the prior mean $0$ and the sample mean $3$, weighted toward the data because the data precision $10/4 = 2.5$ exceeds the prior precision $1$.
</Example>

## The Evidence Lower Bound (ELBO)

For most models of interest (neural networks, deep generative models), the posterior $p(\theta|\mathcal{D})$ is intractable because the evidence integral $p(\mathcal{D}) = \int p(\mathcal{D}|\theta)p(\theta)d\theta$ cannot be computed in closed form. Two main strategies exist: variational inference (optimization-based) and MCMC (sampling-based).

<Definition id="def-vi" name="Variational Inference">
**Variational Inference (VI)** approximates the posterior with a tractable distribution $q_\phi(\theta)$ from a variational family $\mathcal{Q}$ by minimizing the KL divergence:

$$
\phi^* = \arg\min_\phi D_{\text{KL}}(q_\phi(\theta) \| p(\theta | \mathcal{D}))
$$

Since $p(\theta|\mathcal{D})$ appears in the KL (and is unknown), we cannot minimize this directly. Instead, we maximize the **Evidence Lower Bound (ELBO)**:

<Equation id="eq-elbo">

$$\text{ELBO}(\phi) = \mathbb{E}_{q_\phi}[\log p(\mathcal{D} | \theta)] - D_{\text{KL}}(q_\phi(\theta) \| p(\theta)) \leq \log p(\mathcal{D})$$

</Equation>
</Definition>

<Remark id="rmk-elbo-derivation">
**Derivation of the ELBO.** Start from the log-evidence:

$$\log p(\mathcal{D}) = \log \int p(\mathcal{D}, \theta) d\theta = \log \int \frac{p(\mathcal{D}, \theta)}{q_\phi(\theta)} q_\phi(\theta) d\theta \geq \int q_\phi(\theta) \log \frac{p(\mathcal{D}, \theta)}{q_\phi(\theta)} d\theta$$

where the inequality is Jensen's (since $\log$ is concave). Rearranging:

$$\log p(\mathcal{D}) = \underbrace{\mathbb{E}_q[\log p(\mathcal{D}|\theta)] - D_{\text{KL}}(q \| p(\theta))}_{\text{ELBO}} + \underbrace{D_{\text{KL}}(q_\phi(\theta) \| p(\theta|\mathcal{D}))}_{\geq 0}$$

The gap between $\log p(\mathcal{D})$ and the ELBO is exactly $D_{\text{KL}}(q \| p(\theta|\mathcal{D}))$. Maximizing the ELBO simultaneously: (1) makes $q$ close to the true posterior, and (2) provides a lower bound on the model evidence.
</Remark>

<Remark id="rmk-elbo-tradeoff">
**ELBO decomposition and the reconstruction-regularization tradeoff.** The ELBO has two terms:

1. **Reconstruction term** $\mathbb{E}_{q_\phi}[\log p(\mathcal{D}|\theta)]$: encourages $q$ to place mass on parameters that explain the data well (fit the data).
2. **KL regularization** $-D_{\text{KL}}(q_\phi \| p(\theta))$: penalizes $q$ for deviating from the prior (stay simple).

This is the Bayesian analogue of the bias-variance tradeoff: the reconstruction term reduces bias while the KL term controls variance/complexity. In VAEs, the same decomposition appears with latent variables instead of parameters: reconstruction loss vs. KL to the latent prior.
</Remark>

## Approximate Inference Methods

<Definition id="def-mcmc" name="Markov Chain Monte Carlo">
**Markov Chain Monte Carlo (MCMC)** draws samples from the posterior by constructing a Markov chain whose stationary distribution is $p(\theta|\mathcal{D})$. The most common algorithms are:

1. **Metropolis-Hastings:** Propose $\theta' \sim q(\theta'|\theta_t)$, accept with probability $\min(1, \frac{p(\theta'|\mathcal{D})q(\theta_t|\theta')}{p(\theta_t|\mathcal{D})q(\theta'|\theta_t)})$.
2. **Hamiltonian Monte Carlo (HMC):** Use gradient information to make proposals that follow the posterior geometry, achieving much higher acceptance rates in high dimensions.
3. **Stochastic Gradient MCMC (SG-MCMC):** Replace full-data gradients with mini-batch gradients, enabling MCMC at scale. Stochastic Gradient Langevin Dynamics (SGLD) adds explicitly injected Gaussian noise to mini-batch gradients so that, as the step size decays, the iterates sample from the posterior [@welling2011bayesian]. Vanilla SGD without injected noise approximates a different stationary distribution that depends on the gradient-noise covariance, and only matches the posterior under restrictive conditions [@mandt2017stochastic].

MCMC is asymptotically exact (converges to the true posterior) but slow for high-dimensional problems. VI is faster but introduces approximation error from the variational family.
</Definition>

<Table id="tab-approx-inference" caption="Comparison of approximate inference methods.">

| Method | Quality | Speed | Scalability | Key Limitation |
|--------|---------|-------|-------------|----------------|
| Exact (conjugate) | Exact | Fast | Small models only | Requires conjugacy |
| MCMC (HMC) | Asymptotically exact | Slow | $\sim 10^4$ params | Mixing time, burn-in |
| SG-MCMC | Approximate | Moderate | $\sim 10^6$ params | Mini-batch noise |
| Variational Inference | Approximate | Fast | $\sim 10^9$ params | Restricted family $\mathcal{Q}$ |
| Laplace approximation | Gaussian at MAP | Very fast | $\sim 10^6$ params | Unimodal, symmetric |
| Deep ensembles | Empirically good | $M \times$ cost | Any model size | No theoretical guarantee |

</Table>

<Remark id="rmk-laplace-approximation">
**Laplace approximation.** Approximate the posterior as a Gaussian centered at the MAP estimate:

$$p(\theta|\mathcal{D}) \approx \mathcal{N}(\theta_{\text{MAP}}, H^{-1})$$

where $H = -\nabla^2 \log p(\theta|\mathcal{D})\big|_{\theta_{\text{MAP}}}$ is the Hessian of the negative log-posterior at the MAP point. This is the second-order Taylor expansion of $\log p(\theta|\mathcal{D})$ around its mode. The Laplace approximation is fast (just requires the MAP point plus the Hessian) but assumes the posterior is approximately Gaussian, missing multimodality, skewness, and heavy tails.

For neural networks, the full Hessian is $O(P^2)$ in memory. Practical approaches use diagonal, Kronecker-factored (KFAC), or low-rank Hessian approximations [@ritter2018scalable].
</Remark>

## Model Selection and Evidence

<Definition id="def-model-evidence" name="Model Evidence">
The **model evidence** (marginal likelihood) $p(\mathcal{D}|\mathcal{M})$ for model $\mathcal{M}$ scores how well the model class (not just the best fit) explains the data:

<Equation id="eq-model-evidence">

$$p(\mathcal{D}|\mathcal{M}) = \int p(\mathcal{D}|\theta, \mathcal{M}) \, p(\theta|\mathcal{M}) \, d\theta$$

</Equation>

Comparing models: $\frac{p(\mathcal{M}_1|\mathcal{D})}{p(\mathcal{M}_2|\mathcal{D})} = \frac{p(\mathcal{D}|\mathcal{M}_1)}{p(\mathcal{D}|\mathcal{M}_2)} \cdot \frac{p(\mathcal{M}_1)}{p(\mathcal{M}_2)}$
</Definition>

<Remark id="rmk-occam-razor">
**Bayesian Occam's razor.** The evidence automatically penalizes complexity. A complex model spreads its prior probability over many possible datasets, so $p(\mathcal{D}|\mathcal{M})$ is small for any particular $\mathcal{D}$. A simple model concentrates its prior on fewer datasets, so if $\mathcal{D}$ is one of them, the evidence is high. The evidence balances fit and complexity without an explicit regularization term.

This is why the ELBO is a lower bound on $\log p(\mathcal{D})$: maximizing the ELBO over model architectures favors models that are complex enough to explain the data but no more.
</Remark>

## ML Connections

<Table id="tab-bayesian-ml" caption="Bayesian components in modern ML models.">

| Model | Bayesian Component | What It Computes |
|-------|--------------------|-----------------|
| **VAE** | Encoder $q_\phi(z|x)$ approximates posterior $p(z|x)$; ELBO is the training objective | Amortized inference over latent space |
| **Bayesian NN** | Prior over weights $p(w)$; posterior $p(w|\mathcal{D})$ gives uncertainty | Calibrated predictions with error bars |
| **GPT pretraining** | MLE over token sequences: $\max \sum_t \log p(x_t | x_{<t}; \theta)$ | Next-token prediction (no explicit prior) |
| **Diffusion models** | Variational bound on log-likelihood; forward process defines the prior | Score matching approximates $\nabla \log p(x)$ |
| **Gaussian processes** | Exact Bayesian inference with kernel prior | Non-parametric regression with uncertainty |
| **Bayesian optimization** | Posterior over objective function; acquisition function trades off exploration/exploitation | Hyperparameter tuning |
| **Neural architecture search** | Prior over architectures; performance posterior guides search | Automated model design |

</Table>

<Remark id="rmk-bayesian-deep-learning">
**The gap between Bayesian theory and deep learning practice.** In theory, full Bayesian inference is optimal: the predictive distribution minimizes expected loss under the true posterior. In practice, deep learning relies almost entirely on point estimates (SGD/Adam) for several reasons:

1. **Computational cost:** Computing the posterior over $10^9$ parameters is intractable.
2. **Prior specification:** What is a good prior for transformer weights? We have little domain knowledge to guide the choice.
3. **Overparameterization:** When $P \gg N$, the prior has outsized influence; a bad prior hurts more than no prior.
4. **Empirical success:** SGD + regularization + ensembles achieves competitive uncertainty without explicit Bayesian methods.

Despite this, Bayesian ideas permeate deep learning: weight decay is a Gaussian prior, dropout is approximate variational inference, the ELBO trains VAEs, and model evidence guides hyperparameter selection. Understanding the Bayesian perspective illuminates *why* these techniques work.
</Remark>

## Notation Summary

<Table id="tab-notation-bayesian" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\theta$ | Model parameters |
| $\mathcal{D}$ | Observed data |
| $p(\theta)$ | Prior distribution |
| $p(\mathcal{D}|\theta)$ | Likelihood |
| $p(\theta|\mathcal{D})$ | Posterior distribution |
| $p(\mathcal{D})$ | Evidence (marginal likelihood) |
| $q_\phi(\theta)$ | Variational approximation to the posterior |
| $\phi$ | Variational parameters |
| $\mathcal{Q}$ | Variational family |
| ELBO | Evidence lower bound |
| MLE | Maximum likelihood estimation |
| MAP | Maximum a posteriori estimation |
| MCMC | Markov Chain Monte Carlo |
| HMC | Hamiltonian Monte Carlo |
| $H$ | Hessian (in Laplace approximation) |

</Table>
