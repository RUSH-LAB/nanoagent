---
sidebar_position: 2
---

# Distributions

Probability distributions are the building blocks of statistical modeling. Every ML model implicitly or explicitly defines a probability distribution: a classifier outputs a Categorical distribution, a regression model outputs a Gaussian, a language model outputs a distribution over token sequences. This chapter covers the distributions that appear most frequently in machine learning, their properties, and their relationships.

## Discrete Distributions

<Definition id="def-bernoulli" name="Bernoulli Distribution">
**Bernoulli**: a single binary trial with success probability $p$:

<Equation id="eq-bernoulli">

$$P(X = x) = p^x (1-p)^{1-x}, \quad x \in \{0, 1\}$$

</Equation>

$\mathbb{E}[X] = p$, $\text{Var}(X) = p(1-p)$. The Bernoulli is an exponential family distribution with natural parameter $\eta = \log\frac{p}{1-p}$ (the log-odds, or logit).
</Definition>

<Definition id="def-categorical" name="Categorical Distribution">
**Categorical**: the generalization to $K$ classes with probabilities $\pi = (\pi_1, \dots, \pi_K)$:

$$
P(X = k) = \pi_k, \quad \sum_{k=1}^K \pi_k = 1
$$

$\mathbb{E}[\mathbf{1}_{X=k}] = \pi_k$, $\text{Var}(\mathbf{1}_{X=k}) = \pi_k(1 - \pi_k)$.
</Definition>

<Definition id="def-binomial" name="Binomial Distribution">
**Binomial**: the number of successes in $n$ independent Bernoulli$(p)$ trials:

<Equation id="eq-binomial">

$$P(X = k) = \binom{n}{k} p^k (1-p)^{n-k}, \quad k = 0, 1, \ldots, n$$

</Equation>

$\mathbb{E}[X] = np$, $\text{Var}(X) = np(1-p)$. As $n \to \infty$ with $np$ fixed, the Binomial converges to the Poisson. As $n \to \infty$ with $p$ fixed, $\frac{X - np}{\sqrt{np(1-p)}} \to \mathcal{N}(0,1)$ by the CLT.
</Definition>

<Definition id="def-poisson" name="Poisson Distribution">
**Poisson**: models the number of events in a fixed interval when events occur independently at a constant rate $\lambda$:

<Equation id="eq-poisson">

$$P(X = k) = \frac{\lambda^k e^{-\lambda}}{k!}, \quad k = 0, 1, 2, \ldots$$

</Equation>

$\mathbb{E}[X] = \text{Var}(X) = \lambda$. The conjugate prior for the Poisson rate $\lambda$ is the Gamma distribution. It appears in count data modeling (event frequency, word counts in bag-of-words models).
</Definition>

<Remark id="rmk-categorical-softmax">
The Categorical distribution is the output distribution for classification. The softmax function converts logits $z \in \mathbb{R}^K$ to a Categorical distribution: $\pi_k = \frac{e^{z_k}}{\sum_j e^{z_j}}$. The softmax is the inverse of the log-odds (logit) function and arises naturally from the exponential family form of the Categorical. Every classification neural network implicitly defines a Categorical distribution over labels.
</Remark>

<Remark id="rmk-discrete-relationships">
**Relationships between discrete distributions.** The discrete distributions form a hierarchy:

- **Bernoulli** is Categorical with $K = 2$, and Binomial with $n = 1$
- **Binomial** is the sum of $n$ i.i.d. Bernoulli trials
- **Multinomial** is the multivariate generalization: counts of $K$ categories across $n$ trials
- **Poisson** is the limit of Binomial$(n, \lambda/n)$ as $n \to \infty$ (rare events)
- **Geometric** is the number of trials until the first success: $P(X = k) = (1-p)^{k-1}p$
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

The exponent $(x - \mu)^\top \Sigma^{-1}(x - \mu)$ is the **Mahalanobis distance** from $x$ to $\mu$. Level sets of the density are ellipsoids aligned with the eigenvectors of $\Sigma$.
</Definition>

<Table id="tab-gaussian-props" caption="Closure properties of the multivariate Gaussian.">

| Property | Formula | Proof Sketch |
|----------|---------|-------------|
| Marginal | $p(x_A) = \mathcal{N}(\mu_A, \Sigma_{AA})$ | Integrate out $x_B$; completing the square |
| Conditional | $p(x_A | x_B) = \mathcal{N}(\mu_{A|B}, \Sigma_{A|B})$ | $\mu_{A|B} = \mu_A + \Sigma_{AB}\Sigma_{BB}^{-1}(x_B - \mu_B)$, $\Sigma_{A|B} = \Sigma_{AA} - \Sigma_{AB}\Sigma_{BB}^{-1}\Sigma_{BA}$ |
| Sum | $X + Y \sim \mathcal{N}(\mu_X + \mu_Y, \Sigma_X + \Sigma_Y)$ if independent | Convolution of Gaussians via completing the square |
| Linear transform | $AX + b \sim \mathcal{N}(A\mu + b, A\Sigma A^\top)$ | Moment generating function or change of variables |
| Product | $\mathcal{N}(\mu_1, \Sigma_1) \cdot \mathcal{N}(\mu_2, \Sigma_2) \propto \mathcal{N}(\mu_*, \Sigma_*)$ | $\Sigma_*^{-1} = \Sigma_1^{-1} + \Sigma_2^{-1}$ (precision addition) |

</Table>

<Remark id="rmk-gaussian-conditional">
**Gaussian conditioning and Bayesian linear regression.** The conditional formula $\mu_{A|B} = \mu_A + \Sigma_{AB}\Sigma_{BB}^{-1}(x_B - \mu_B)$ is a linear function of $x_B$, which is why Bayesian linear regression (Gaussian prior + Gaussian likelihood) yields a Gaussian posterior in closed form. The posterior mean is the regularized least-squares solution, and the posterior covariance quantifies parameter uncertainty.
</Remark>

<Remark id="rmk-gaussian-central">
The Gaussian distribution is central to ML for several deep reasons:

1. **Maximum entropy:** Among all distributions with given mean and variance, the Gaussian has maximum entropy (maximum uncertainty). Using a Gaussian makes the fewest assumptions beyond first and second moments.
2. **Central Limit Theorem:** Sums of many independent random variables converge to a Gaussian, regardless of the original distribution. This justifies Gaussian noise models whenever errors arise from many small independent sources.
3. **Algebraic closure:** Gaussians are closed under marginalization, conditioning, linear transformation, and products. This enables exact inference in linear-Gaussian models (Kalman filter, factor analysis, Gaussian processes).
4. **MLE connection:** Minimizing MSE loss $\|y - f(x)\|^2$ is equivalent to MLE under Gaussian noise $y \sim \mathcal{N}(f(x), \sigma^2 I)$.
</Remark>

<Example id="ex-gaussian-precision">
**Precision matrix and conditional independence.** The **precision matrix** $\Lambda = \Sigma^{-1}$ encodes conditional independence: $\Lambda_{ij} = 0$ iff $X_i \perp X_j \mid X_{\setminus\{i,j\}}$. This makes the precision matrix the natural parameterization for Gaussian graphical models (also called Gaussian Markov Random Fields). In a graph where edges represent non-zero precision entries, inference is efficient when the graph is sparse.
</Example>

<Example id="ex-gaussian-density" name="Evaluating a bivariate Gaussian density">
Let $x = (1, 0)^\top$, $\mu = (0, 0)^\top$, and $\Sigma = \begin{pmatrix} 2 & 0 \\ 0 & 1 \end{pmatrix}$. We evaluate $p(x)$ for the multivariate Gaussian.

**Step 1: Determinant and inverse.** Because $\Sigma$ is diagonal, $|\Sigma| = 2 \cdot 1 = 2$ and $\Sigma^{-1} = \begin{pmatrix} 1/2 & 0 \\ 0 & 1 \end{pmatrix}$.

**Step 2: Mahalanobis distance.** With $x - \mu = (1, 0)^\top$,

$$(x - \mu)^\top \Sigma^{-1}(x - \mu) = \tfrac{1}{2}(1)^2 + 1 \cdot (0)^2 = \tfrac{1}{2}.$$

**Step 3: Normalizing constant.** For $n = 2$, $(2\pi)^{n/2}|\Sigma|^{1/2} = 2\pi \cdot \sqrt{2}$.

**Step 4: Assemble.**

$$p(x) = \frac{1}{2\pi\sqrt{2}} \exp\left(-\tfrac{1}{2} \cdot \tfrac{1}{2}\right) = \frac{e^{-1/4}}{2\pi\sqrt{2}} \approx \frac{0.7788}{8.886} \approx 0.0877.$$
</Example>

<Example id="ex-em-iteration" name="One EM iteration on a tiny dataset (harder)">
Consider a one-dimensional two-component GMM and the dataset $x = \{0, 1, 4, 5\}$. Suppose the current parameters are $\mu_1 = 0$, $\mu_2 = 5$, equal variances $\sigma_1^2 = \sigma_2^2 = 1$, and equal weights $\pi_1 = \pi_2 = 0.5$. Run one EM iteration. Try the E-step yourself before reading on, using the responsibility formula from the EM remark below.

**E-step.** The unnormalized weights for component $k$ are $\pi_k\,\mathcal{N}(x_i \mid \mu_k, 1)$, and $r_{ik}$ normalizes them across $k$. Because the two components are symmetric here, the responsibility $r_{i1}$ for component 1 depends only on the squared-distance gap $d_i = \tfrac{1}{2}\big[(x_i - \mu_2)^2 - (x_i - \mu_1)^2\big]$, giving $r_{i1} = \sigma(d_i)$ with $\sigma$ the logistic function:

- $x = 0$: $d = \tfrac{1}{2}(25 - 0) = 12.5$, so $r_{11} = \sigma(12.5) \approx 1.000$.
- $x = 1$: $d = \tfrac{1}{2}(16 - 1) = 7.5$, so $r_{21} \approx 0.9994$.
- $x = 4$: $d = \tfrac{1}{2}(1 - 16) = -7.5$, so $r_{31} \approx 0.0006$.
- $x = 5$: $d = \tfrac{1}{2}(0 - 25) = -12.5$, so $r_{41} \approx 0.000$.

**M-step (means).** Using $\mu_k^{(t+1)} = \frac{\sum_i r_{ik} x_i}{\sum_i r_{ik}}$:

$$\mu_1^{(t+1)} = \frac{1.000\cdot 0 + 0.9994\cdot 1 + 0.0006\cdot 4 + 0\cdot 5}{1.000 + 0.9994 + 0.0006 + 0} \approx \frac{1.0018}{2.000} \approx 0.501.$$

By the symmetry $r_{i2} = 1 - r_{i1}$, the mirror computation gives $\mu_2^{(t+1)} \approx 4.499$.

**M-step (weights).** $\pi_1^{(t+1)} = \tfrac{1}{4}\sum_i r_{i1} = \tfrac{1}{4}(2.000) = 0.500$, and $\pi_2^{(t+1)} = 0.500$.

After one iteration the means have moved toward the cluster centroids ($0.5$ and $4.5$), illustrating how EM tightens the fit. Iterating further leaves them essentially fixed at this symmetric optimum.
</Example>

## Exponential Family

<Definition id="def-exponential-family" name="Exponential Family">
A distribution belongs to the **exponential family** if its density can be written as:

<Equation id="eq-exponential-family">

$$p(x | \eta) = h(x) \exp\left(\eta^\top T(x) - A(\eta)\right)$$

</Equation>

where $\eta$ is the **natural parameter**, $T(x)$ is the **sufficient statistic**, $A(\eta)$ is the **log-partition function** (ensures normalization), and $h(x)$ is the **base measure**.
</Definition>

<Table id="tab-exponential-family" caption="Common distributions as exponential family members.">

| Distribution | $\eta$ (natural param) | $T(x)$ (sufficient stat) | $A(\eta)$ (log-partition) |
|-------------|----------------------|--------------------------|--------------------------|
| Bernoulli($p$) | $\log\frac{p}{1-p}$ | $x$ | $\log(1 + e^\eta)$ |
| Gaussian($\mu, \sigma^2$) | $(\mu/\sigma^2, -1/2\sigma^2)$ | $(x, x^2)$ | $-\eta_1^2/(4\eta_2) - \frac{1}{2}\log(-2\eta_2)$ |
| Poisson($\lambda$) | $\log \lambda$ | $x$ | $e^\eta$ |
| Categorical($\pi$) | $\log \pi_k / \pi_K$ | $\mathbf{1}_{x=k}$ | $\log\sum_k e^{\eta_k}$ (logsumexp) |
| Dirichlet($\alpha$) | $\alpha_k - 1$ | $\log x_k$ | $\sum \log\Gamma(\alpha_k) - \log\Gamma(\sum \alpha_k)$ |

</Table>

<Remark id="rmk-exponential-family-ml">
**Why the exponential family matters for ML:**

1. **Sufficient statistics:** $T(x)$ captures all information about $\eta$ from the data. For $n$ i.i.d. samples, $\sum_i T(x_i)$ is sufficient, so you never need to store raw data.
2. **Log-partition function properties:** $\nabla_\eta A(\eta) = \mathbb{E}[T(X)]$ and $\nabla^2_\eta A(\eta) = \text{Cov}[T(X)]$. Since covariance matrices are PSD, $A(\eta)$ is convex, making MLE a convex problem.
3. **Conjugate priors** always exist and have a known form.
4. **GLMs (Generalized Linear Models):** Each exponential family member defines a GLM. Logistic regression uses Bernoulli, Poisson regression uses Poisson, linear regression uses Gaussian. The link function is $g(\mu) = \eta = w^\top x$.
5. **Softmax is the log-partition:** The Categorical log-partition $A(\eta) = \text{logsumexp}(\eta)$ is exactly the softmax denominator. The gradient $\nabla A = \text{softmax}(\eta)$ gives the mean parameters (class probabilities).
</Remark>

## Softmax and Temperature

<Definition id="def-softmax" name="Softmax Function">
The **softmax function** maps logits $z \in \mathbb{R}^K$ to a probability distribution:

<Equation id="eq-softmax-dist">

$$\text{softmax}(z)_k = \frac{e^{z_k}}{\sum_{j=1}^K e^{z_j}}$$

</Equation>

With **temperature** $\tau > 0$: $\text{softmax}(z/\tau)_k$. As $\tau \to 0$, the distribution approaches argmax (deterministic). As $\tau \to \infty$, it approaches uniform.
</Definition>

<Remark id="rmk-softmax-properties">
**Softmax properties and numerical stability:**

- **Invariance to shift:** $\text{softmax}(z + c) = \text{softmax}(z)$ for any scalar $c$. For numerical stability, compute $\text{softmax}(z - \max_k z_k)$.
- **Gradient:** $\frac{\partial \text{softmax}(z)_i}{\partial z_j} = \text{softmax}(z)_i(\delta_{ij} - \text{softmax}(z)_j)$. This means the Jacobian is $\text{diag}(p) - pp^\top$.
- **Log-softmax:** $\log\text{softmax}(z)_k = z_k - \text{logsumexp}(z)$. Always compute log-softmax directly (numerically stable) rather than $\log(\text{softmax}(z))$.
- **Hardmax limit:** As $\tau \to 0$, softmax approaches one-hot encoding of $\arg\max z$. The Gumbel-Softmax trick [@jang2017categorical; @maddison2017concrete] provides a differentiable approximation to discrete sampling.
</Remark>

<Remark id="rmk-temperature-scaling">
**Temperature in practice:**

| Temperature | Effect | Use Case |
|------------|--------|----------|
| $\tau \ll 1$ | Sharp, near-deterministic | Greedy decoding, distillation (hard labels) |
| $\tau = 1$ | Standard softmax | Training, standard inference |
| $\tau > 1$ | Smoother, more uniform | Knowledge distillation (soft labels), exploration |
| $\tau \to \infty$ | Uniform distribution | Maximum entropy / random baseline |

In knowledge distillation [@hinton2015distilling], the teacher's softmax is evaluated at high temperature to expose "dark knowledge" (relative probabilities of non-target classes). The student is trained to match these soft targets.
</Remark>

## Continuous Distributions Beyond the Gaussian

<Definition id="def-uniform" name="Uniform Distribution">
The **continuous uniform** distribution on $[a, b]$:

$$p(x) = \frac{1}{b - a} \quad \text{for } x \in [a, b]$$

$\mathbb{E}[X] = \frac{a+b}{2}$, $\text{Var}(X) = \frac{(b-a)^2}{12}$. Among all distributions on $[a,b]$, the uniform has maximum entropy.
</Definition>

<Definition id="def-beta" name="Beta Distribution">
The **Beta** distribution on $[0, 1]$ with shape parameters $\alpha, \beta > 0$:

<Equation id="eq-beta">

$$p(x) = \frac{x^{\alpha-1}(1-x)^{\beta-1}}{B(\alpha, \beta)}, \quad x \in [0, 1]$$

</Equation>

where $B(\alpha, \beta) = \frac{\Gamma(\alpha)\Gamma(\beta)}{\Gamma(\alpha + \beta)}$. $\mathbb{E}[X] = \frac{\alpha}{\alpha + \beta}$, $\text{Var}(X) = \frac{\alpha\beta}{(\alpha + \beta)^2(\alpha + \beta + 1)}$. The Beta is the conjugate prior for the Bernoulli parameter $p$.
</Definition>

<Definition id="def-dirichlet" name="Dirichlet Distribution">
The **Dirichlet** distribution generalizes the Beta to $K$-dimensional probability vectors:

<Equation id="eq-dirichlet">

$$p(\pi | \alpha) = \frac{\Gamma(\sum_k \alpha_k)}{\prod_k \Gamma(\alpha_k)} \prod_{k=1}^K \pi_k^{\alpha_k - 1}, \quad \pi \in \Delta^{K-1}$$

</Equation>

where $\Delta^{K-1} = \{\pi : \pi_k \geq 0, \sum_k \pi_k = 1\}$ is the probability simplex. $\mathbb{E}[\pi_k] = \alpha_k / \alpha_0$ where $\alpha_0 = \sum_k \alpha_k$. The concentration parameter $\alpha_0$ controls how peaked the distribution is: $\alpha_0 \to 0$ concentrates on vertices (sparse), $\alpha_0 \to \infty$ concentrates on the center (uniform).
</Definition>

<Definition id="def-gamma" name="Gamma Distribution">
The **Gamma** distribution with shape $\alpha > 0$ and rate $\beta > 0$:

$$p(x) = \frac{\beta^\alpha}{\Gamma(\alpha)} x^{\alpha-1} e^{-\beta x}, \quad x > 0$$

$\mathbb{E}[X] = \alpha/\beta$, $\text{Var}(X) = \alpha/\beta^2$. Special cases: Exponential ($\alpha = 1$), Chi-squared ($\alpha = k/2, \beta = 1/2$). The Gamma is the conjugate prior for the Poisson rate and the Gaussian precision.
</Definition>

<Table id="tab-continuous-distributions" caption="Continuous distributions commonly used in ML.">

| Distribution | Support | Key Property | ML Usage |
|-------------|---------|-------------|----------|
| Gaussian $\mathcal{N}(\mu, \sigma^2)$ | $\mathbb{R}$ | Max entropy for given mean/variance | Noise model, latent space, weight initialization |
| Uniform $U(a,b)$ | $[a,b]$ | Max entropy on bounded support | Prior for bounded parameters, random init |
| Beta $B(\alpha, \beta)$ | $[0,1]$ | Conjugate to Bernoulli | Prior on probabilities, dropout rate |
| Dirichlet $\text{Dir}(\alpha)$ | Simplex $\Delta^{K-1}$ | Conjugate to Categorical | Prior on mixture weights, topic models |
| Gamma $\Gamma(\alpha, \beta)$ | $\mathbb{R}^+$ | Conjugate to Poisson/Gaussian precision | Prior on positive parameters |
| Student-$t$ | $\mathbb{R}$ | Heavy tails (robust) | Robust regression, outlier modeling |
| Laplace | $\mathbb{R}$ | $p(x) \propto e^{-|x|/b}$ | L1 regularization prior |
| Log-normal | $\mathbb{R}^+$ | $\log X \sim \mathcal{N}$ | Multiplicative positive quantities (scales, durations) |

</Table>

## Mixture Models

<Definition id="def-gmm" name="Gaussian Mixture Model">
A **Gaussian mixture model** (GMM) combines $K$ Gaussian components:

<Equation id="eq-gmm">

$$p(x) = \sum_{k=1}^K \pi_k \, \mathcal{N}(x | \mu_k, \Sigma_k)$$

</Equation>

where $\pi_k$ are mixing weights ($\sum_k \pi_k = 1$, $\pi_k \geq 0$). Given enough components, GMMs are universal approximators for densities: they can approximate a broad class of smooth densities to arbitrary accuracy, which makes them a flexible default for modeling multimodal data.
</Definition>

<Remark id="rmk-em-algorithm">
**EM algorithm for GMMs.** Since the component assignments $z_i$ are unobserved (latent), direct MLE is intractable. The **Expectation-Maximization (EM)** algorithm alternates:

1. **E-step:** Compute responsibilities $r_{ik} = P(z_i = k | x_i, \theta^{(t)}) = \frac{\pi_k \mathcal{N}(x_i | \mu_k, \Sigma_k)}{\sum_j \pi_j \mathcal{N}(x_i | \mu_j, \Sigma_j)}$
2. **M-step:** Update parameters using weighted statistics:
   - $\mu_k^{(t+1)} = \frac{\sum_i r_{ik} x_i}{\sum_i r_{ik}}$, $\Sigma_k^{(t+1)} = \frac{\sum_i r_{ik}(x_i - \mu_k)(x_i - \mu_k)^\top}{\sum_i r_{ik}}$, $\pi_k^{(t+1)} = \frac{1}{N}\sum_i r_{ik}$

EM monotonically increases the log-likelihood and converges to a local maximum. It generalizes beyond GMMs to any latent variable model.
</Remark>

<Remark id="rmk-latent-variable">
**Latent variable models.** Mixture models introduce a latent variable $z$ (the component assignment). The marginal $p(x) = \sum_z p(x|z)p(z)$ integrates over the latent. This is the same structure as:

- **VAEs** [@kingma2014vae]: continuous latent $z \in \mathbb{R}^d$, $p(x|z)$ is a neural network decoder
- **Diffusion models** [@ho2020ddpm]: chain of latents $x_T \to x_{T-1} \to \cdots \to x_0$
- **Topic models (LDA):** latent topic assignments for each word
- **Hidden Markov models:** latent discrete states with temporal dependencies

The key computational challenge in all these models is computing or approximating the posterior $p(z|x)$.
</Remark>

## Important Limit Theorems

<Theorem id="thm-lln" name="Law of Large Numbers">
Let $X_1, X_2, \ldots$ be i.i.d. with mean $\mu$ and finite variance. The **strong law of large numbers** states:

<Equation id="eq-lln">

$$\bar{X}_n = \frac{1}{n}\sum_{i=1}^n X_i \xrightarrow{\text{a.s.}} \mu \quad \text{as } n \to \infty$$

</Equation>

This justifies using empirical averages (mini-batch gradients, empirical risk) as estimators of expectations.
</Theorem>

<Theorem id="thm-clt" name="Central Limit Theorem">
Let $X_1, X_2, \ldots$ be i.i.d. with mean $\mu$ and variance $\sigma^2 < \infty$. Then:

<Equation id="eq-clt">

$$\frac{\bar{X}_n - \mu}{\sigma / \sqrt{n}} \xrightarrow{d} \mathcal{N}(0, 1) \quad \text{as } n \to \infty$$

</Equation>

The CLT tells us the rate: $\bar{X}_n$ is approximately $\mathcal{N}(\mu, \sigma^2/n)$, so the estimation error scales as $O(1/\sqrt{n})$ regardless of the original distribution.
</Theorem>

<Remark id="rmk-clt-ml">
**CLT in ML:**

- **Mini-batch gradients:** The average gradient over a mini-batch of size $B$ has variance $\sigma^2/B$, approximately Gaussian for moderate $B$ by the CLT. This motivates the empirical learning rate linear scaling rule [@goyal2017accurate]: increasing $B$ by $k$ and increasing $\eta$ by $k$ keeps the noise-to-signal ratio roughly constant. The rule is a heuristic that works well up to moderate batch sizes and is known to break down in the very large batch regime.
- **Confidence intervals:** For any estimator computed as an average (accuracy, loss, BLEU score), the CLT gives approximate confidence intervals: $\hat{\mu} \pm z_{\alpha/2} \cdot \hat{\sigma}/\sqrt{n}$.
- **Batch normalization:** The sample mean and variance computed over a mini-batch converge to population statistics by the LLN, with CLT-governed fluctuations.
</Remark>

## Transformations of Random Variables

<Definition id="def-change-of-variables" name="Change of Variables">
If $X \sim p_X$ and $Y = g(X)$ where $g$ is a differentiable bijection with inverse $g^{-1}$, then:

<Equation id="eq-change-of-variables">

$$p_Y(y) = p_X(g^{-1}(y)) \left|\det \frac{\partial g^{-1}}{\partial y}\right| = p_X(g^{-1}(y)) \left|\det \frac{\partial g}{\partial x}\right|^{-1}$$

</Equation>

The Jacobian determinant accounts for the stretching or compression of volume by $g$.
</Definition>

<Remark id="rmk-change-of-variables-ml">
**Change of variables in ML.** This formula is the foundation of:

- **Normalizing flows** [@rezende2015variational]: Compose simple bijections $g_1 \circ g_2 \circ \cdots \circ g_L$ to transform a simple base distribution (e.g., Gaussian) into a complex target. The log-density of the transformed variable is $\log p_X(x) - \sum_l \log|\det J_l|$.
- **Reparameterization trick** [@kingma2014vae]: Sample $z = \mu + \sigma \odot \epsilon$ where $\epsilon \sim \mathcal{N}(0, I)$. This moves the stochasticity out of the distribution parameters, enabling backpropagation through the sampling step.
- **Probability integral transform:** If $X \sim F$ with $F$ continuous, then $F(X) \sim U(0,1)$. (The result requires continuity of $F$; it fails for discrete or mixed distributions.) This is used for calibration assessment and copula models.
</Remark>

## Notation Summary

<Table id="tab-notation-dist" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $p, \pi$ | Probability density / mixing weight |
| $\mu$ | Mean (scalar or vector) |
| $\sigma^2, \Sigma$ | Variance (scalar) / covariance (matrix) |
| $\Lambda = \Sigma^{-1}$ | Precision matrix |
| $\mathcal{N}(\mu, \Sigma)$ | Gaussian distribution |
| $\tau$ | Temperature parameter |
| $K$ | Number of classes or mixture components |
| $z$ | Logits or latent variable |
| $\eta$ | Natural parameter (exponential family) |
| $T(x)$ | Sufficient statistic |
| $A(\eta)$ | Log-partition function |
| $B(\alpha, \beta)$ | Beta function |
| $\Gamma(\cdot)$ | Gamma function |
| $\Delta^{K-1}$ | $(K-1)$-dimensional probability simplex |

</Table>
