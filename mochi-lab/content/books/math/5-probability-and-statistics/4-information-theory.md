---
sidebar_position: 4
---

# Information Theory

Information theory, founded by Shannon (1948), provides the mathematical framework for quantifying information, uncertainty, and the cost of communication. In machine learning, information-theoretic quantities serve as training objectives (cross-entropy loss), regularizers (KL divergence), model selection criteria (MDL), and theoretical tools for understanding representations (information bottleneck). This chapter covers the key concepts and their ML applications.

## Entropy

<Definition id="def-entropy-it" name="Entropy">
The **entropy** of a discrete distribution $p$ measures the expected information content (or uncertainty):

<Equation id="eq-shannon-entropy">

$$H(p) = -\sum_x p(x) \log p(x) = \mathbb{E}_{p}[-\log p(X)]$$

</Equation>

For continuous distributions, the **differential entropy** is $h(p) = -\int p(x) \log p(x) \, dx$.
</Definition>

**Properties of entropy:**

- **Non-negativity:** $H(p) \geq 0$ for discrete distributions (with equality iff $p$ is a point mass). Note: differential entropy can be negative.
- **Maximum entropy:** For $K$ outcomes: $H(p) \leq \log K$ with equality iff $p$ is uniform.
- **Concavity:** $H(\lambda p + (1-\lambda)q) \geq \lambda H(p) + (1-\lambda)H(q)$: mixing distributions increases uncertainty.
- **Chain rule:** $H(X, Y) = H(X) + H(Y|X)$ (joint entropy = marginal + conditional).
- **Conditioning reduces entropy:** $H(X|Y) \leq H(X)$ with equality iff $X \perp Y$.

<Remark id="rmk-entropy-meaning">
**Operational interpretation.** Throughout this chapter $\log$ denotes the natural logarithm (nats) unless a base is stated explicitly, in which case $\log_2$ gives bits. Entropy is the expected number of bits (if $\log_2$) or nats (if $\ln$) needed to optimally encode samples from $p$. Shannon's source coding theorem states that the optimal lossless compression rate for i.i.d. samples from $p$ is exactly $H(p)$ bits per sample. No encoding can do better on average.

**Maximum entropy distributions.** Given constraints, the maximum entropy distribution makes the fewest assumptions:
- Given mean and variance $\to$ Gaussian
- Given support $[a,b]$ $\to$ Uniform
- Given mean $\lambda$ on $\mathbb{N}$ $\to$ Poisson
- Given support $\mathbb{R}^+$ and mean $\to$ Exponential

This principle justifies common distributional assumptions in ML.
</Remark>

<Example id="ex-entropy-binary">
**Binary entropy.** For a Bernoulli variable with $P(X=1) = p$:

$$H(p) = -p\log p - (1-p)\log(1-p)$$

This is maximized at $p = 1/2$ ($H = \log_2 2 = 1$ bit) and zero at $p \in \{0, 1\}$. At an intermediate point such as $p = 1/4$ (using $\log_2$ for bits):

$$H(1/4) = -\tfrac{1}{4}\log_2 \tfrac{1}{4} - \tfrac{3}{4}\log_2 \tfrac{3}{4} = \tfrac{1}{4}(2) + \tfrac{3}{4}(0.415) \approx 0.811 \text{ bits}.$$

The binary entropy function appears in the cross-entropy loss for binary classification, where it measures the cost per sample of using model probabilities $q$ when the true label distribution is $p$.
</Example>

## Cross-Entropy

<Definition id="def-cross-entropy-it" name="Cross-Entropy">
The **cross-entropy** between a true distribution $p$ and a model $q$:

<Equation id="eq-cross-entropy-it">

$$H(p, q) = -\sum_x p(x) \log q(x) = H(p) + D_{\text{KL}}(p \| q)$$

</Equation>

Since $H(p)$ is constant during optimization (the data distribution is fixed), minimizing cross-entropy is equivalent to minimizing KL divergence from $p$ to $q$.
</Definition>

<Remark id="rmk-cross-entropy-loss">
**Cross-entropy as the universal training loss.** Cross-entropy loss in ML is exactly this quantity applied to empirical distributions:

- **Classification:** $p$ is the one-hot label $e_y$ and $q$ is the softmax output. Then $H(e_y, q) = -\log q_y$, which is the negative log-likelihood of the correct class.
- **Language modeling:** $p$ is the one-hot next-token label and $q$ is the model's predicted distribution over vocabulary. The loss $-\log q(x_t | x_{<t})$ averaged over tokens is the cross-entropy, and $\exp(H)$ is the perplexity.
- **Regression with Gaussian noise:** $-\log \mathcal{N}(y|\mu, \sigma^2) = \frac{(y-\mu)^2}{2\sigma^2} + \frac{1}{2}\log(2\pi\sigma^2)$, which reduces to MSE for fixed $\sigma$.

In all cases, minimizing cross-entropy = maximizing log-likelihood = minimizing KL divergence from the empirical distribution to the model.
</Remark>

<Remark id="rmk-perplexity">
**Perplexity.** The perplexity of a language model is:

$$\text{PPL} = \exp\left(-\frac{1}{T}\sum_{t=1}^T \log p(x_t | x_{<t})\right) = \exp(H_{\text{cross-entropy}})$$

Perplexity measures how many equally likely next tokens the model considers on average. Lower perplexity = better model. A perplexity of $K$ means the model is as uncertain as a uniform distribution over $K$ tokens. For English text, strong language models are typically reported to reach word-level perplexity in roughly the $10$-$30$ range on standard benchmarks, with the exact figure depending heavily on tokenization and dataset.
</Remark>

## KL Divergence

<Definition id="def-kl-it" name="KL Divergence">
The **Kullback-Leibler divergence** from $q$ to $p$ [@kullback1951information]:

<Equation id="eq-kl-it">

$$D_{\text{KL}}(p \| q) = \sum_x p(x) \log \frac{p(x)}{q(x)} = \mathbb{E}_p\left[\log \frac{p(x)}{q(x)}\right] \geq 0$$

</Equation>

For continuous distributions: $D_{\text{KL}}(p \| q) = \int p(x) \log \frac{p(x)}{q(x)} dx$.
</Definition>

**Properties of KL divergence:**

- **Non-negative** (Gibbs' inequality): $D_{\text{KL}}(p \| q) \geq 0$ with equality iff $p = q$ a.e.
- **Not a metric:** Not symmetric ($D_{\text{KL}}(p\|q) \neq D_{\text{KL}}(q\|p)$), does not satisfy triangle inequality.
- **Additive for products:** $D_{\text{KL}}(p_1 p_2 \| q_1 q_2) = D_{\text{KL}}(p_1\|q_1) + D_{\text{KL}}(p_2\|q_2)$ for independent distributions.
- **Invariant under reparameterization:** KL divergence is unchanged by invertible transformations of the sample space.
- **Can be infinite:** $D_{\text{KL}}(p\|q) = \infty$ if there exists $x$ with $p(x) > 0$ and $q(x) = 0$ (support mismatch).

<Table id="tab-kl-directions-detailed" caption="Forward vs reverse KL divergence behavior.">

| Direction | Minimizer Behavior | Name | Used In |
|-----------|-------------------|------|---------|
| $D_{\text{KL}}(p \| q)$ | $q$ must cover all modes of $p$ (zero-avoiding) | Forward KL (mean-seeking) | MLE, cross-entropy loss |
| $D_{\text{KL}}(q \| p)$ | $q$ concentrates on one mode of $p$ (zero-forcing) | Reverse KL (mode-seeking) | VI, ELBO, policy optimization |

</Table>

<Remark id="rmk-kl-direction-ml">
**KL direction matters profoundly in practice.**

- **MLE minimizes forward KL** $D_{\text{KL}}(p_{\text{data}} \| p_\theta)$: the model must assign non-zero probability everywhere the data has support, or pay infinite cost. This makes MLE-trained models "mode-covering": they produce diverse but sometimes low-quality samples.
- **VI minimizes reverse KL** $D_{\text{KL}}(q_\phi \| p(\theta|\mathcal{D}))$: the approximation $q$ can safely ignore modes of $p$ it cannot fit. This makes VI "mode-seeking": the approximation is tight around one mode but may miss others.
- **RLHF uses forward KL as a constraint:** $D_{\text{KL}}(\pi \| \pi_{\text{ref}}) \leq \epsilon$ prevents the policy from deviating too far from the reference model, maintaining generation quality.
- **GANs approximate** various $f$-divergences (including KL) depending on the discriminator architecture.
</Remark>

<Example id="ex-kl-gaussians">
**KL between Gaussians.** For two multivariate Gaussians $p = \mathcal{N}(\mu_1, \Sigma_1)$ and $q = \mathcal{N}(\mu_2, \Sigma_2)$ in $\mathbb{R}^d$:

$$D_{\text{KL}}(p \| q) = \frac{1}{2}\left[\text{tr}(\Sigma_2^{-1}\Sigma_1) + (\mu_2 - \mu_1)^\top \Sigma_2^{-1}(\mu_2 - \mu_1) - d + \log\frac{|\Sigma_2|}{|\Sigma_1|}\right]$$

For the special case $p = \mathcal{N}(\mu, \text{diag}(\sigma^2))$ and $q = \mathcal{N}(0, I)$ (the VAE KL term):

$$D_{\text{KL}}(p \| q) = \frac{1}{2}\sum_{j=1}^d \left[\sigma_j^2 + \mu_j^2 - 1 - \log \sigma_j^2\right]$$

This closed-form KL is why VAEs use Gaussian encoder and prior: it makes the ELBO tractable.
</Example>

## f-Divergences

<Definition id="def-f-divergence" name="f-Divergence">
The **$f$-divergence** [@csiszar1967information; @ali1966general] generalizes KL divergence using a convex function $f$ with $f(1) = 0$:

<Equation id="eq-f-divergence">

$$D_f(p \| q) = \mathbb{E}_q\left[f\left(\frac{p(x)}{q(x)}\right)\right] = \int q(x) f\left(\frac{p(x)}{q(x)}\right) dx$$

</Equation>
</Definition>

<Table id="tab-f-divergences" caption="Common f-divergences and their generators.">

| Name | $f(t)$ | $D_f(p\|q)$ | ML Usage |
|------|--------|-------------|----------|
| KL divergence | $t \log t$ | $\mathbb{E}_p[\log(p/q)]$ | MLE, ELBO |
| Reverse KL | $-\log t$ | $\mathbb{E}_q[\log(q/p)]$ | VI, policy optimization |
| Jensen-Shannon | $-(1+t)\log\frac{1+t}{2} + t\log t$ | $\frac{1}{2}D_{\text{KL}}(p\|m) + \frac{1}{2}D_{\text{KL}}(q\|m)$ | Original GAN objective |
| Chi-squared | $(t-1)^2$ | $\mathbb{E}_q[(p/q - 1)^2]$ | Importance weighting diagnostics |
| Total variation | $\frac{1}{2}|t-1|$ | $\frac{1}{2}\sum |p(x) - q(x)|$ | Distributional robustness |
| Hellinger | $(\sqrt{t} - 1)^2$ | $\int (\sqrt{p} - \sqrt{q})^2 dx$ | Statistical testing |

</Table>

<Remark id="rmk-f-divergence-variational">
**Variational representation and GANs.** Every $f$-divergence has a variational (dual) representation:

$$D_f(p \| q) = \sup_T \left\{\mathbb{E}_p[T(x)] - \mathbb{E}_q[f^*(T(x))]\right\}$$

where $f^*$ is the convex conjugate of $f$. This is the basis of $f$-GANs [@nowozin2016fgan]: the discriminator $T$ maximizes the variational bound, while the generator minimizes it. Different choices of $f$ yield different GAN objectives:

- $f(t) = t \log t$: KL-GAN
- JS divergence: Original GAN
- $f(t) = (t-1)^2$: Least-squares GAN

The Wasserstein distance (used in WGAN) is *not* an $f$-divergence: it is an optimal transport distance that metrizes weak convergence, avoiding the mode collapse issues of $f$-divergences.
</Remark>

## Mutual Information

<Definition id="def-mutual-info" name="Mutual Information">
The **mutual information** between $X$ and $Y$ measures the reduction in uncertainty about one variable given knowledge of the other:

<Equation id="eq-mutual-info">

$$I(X; Y) = D_{\text{KL}}(p(X, Y) \| p(X)p(Y)) = H(X) - H(X|Y) = H(Y) - H(Y|X)$$

</Equation>

Equivalently: $I(X;Y) = H(X) + H(Y) - H(X,Y)$.
</Definition>

**Properties of mutual information:**

- **Non-negative:** $I(X;Y) \geq 0$ with equality iff $X \perp Y$.
- **Symmetric:** $I(X;Y) = I(Y;X)$ (unlike KL divergence).
- **Invariant under bijections:** $I(X;Y) = I(f(X); g(Y))$ for invertible $f, g$.
- **Bounds entropy:** $I(X;Y) \leq \min(H(X), H(Y))$.
- **Chain rule:** $I(X; Y, Z) = I(X; Y) + I(X; Z | Y)$.

<Remark id="rmk-mutual-info-ml">
**Mutual information in ML:**

<Table id="tab-mutual-info-ml" caption="Applications of mutual information in machine learning.">

| Application | How MI Is Used |
|-------------|---------------|
| **Feature selection** | Select features $X_i$ that maximize $I(X_i; Y)$ with the target |
| **InfoNCE loss** [@oord2018infonce] | Lower bound on $I(X; Z)$ using contrastive learning: $I(X;Z) \geq \log N - \mathcal{L}_{\text{NCE}}$ |
| **Information bottleneck** [@tishby2000information] | Find representation $Z$ that maximizes $I(Z; Y)$ while minimizing $I(X; Z)$ |
| **Representation quality** | Good representations have high $I(Z; Y)$ (predictive) and low $I(Z; X|Y)$ (compressed) |
| **Independence testing** | $I(X; Y) = 0 \iff X \perp Y$ (stronger than correlation, captures nonlinear dependence) |
| **Variational bounds** | Used in MINE [@belghazi2018mine], InfoNCE, and other contrastive objectives |

</Table>

MI captures *all* statistical dependencies (not just linear), making it the "gold standard" measure of association. However, MI is notoriously hard to estimate in high dimensions: practical estimators use variational bounds.
</Remark>

## Conditional Entropy and Chain Rules

<Definition id="def-conditional-entropy" name="Conditional Entropy">
The **conditional entropy** of $X$ given $Y$ is the expected uncertainty remaining in $X$ after observing $Y$:

<Equation id="eq-conditional-entropy">

$$H(X|Y) = -\sum_{x,y} p(x,y) \log p(x|y) = H(X,Y) - H(Y)$$

</Equation>
</Definition>

<Remark id="rmk-information-diagram">
**The information diagram.** The relationships between entropy, conditional entropy, mutual information, and joint entropy follow a set-like algebra (entropies behave like set sizes, with $I(X;Y)$ playing the role of an intersection):

- $H(X,Y) = H(X) + H(Y|X) = H(Y) + H(X|Y)$ (chain rule)
- $I(X;Y) = H(X) - H(X|Y) = H(Y) - H(Y|X)$ (mutual information as overlap)
- $H(X,Y) = H(X) + H(Y) - I(X;Y)$ (joint = sum - overlap)

These identities are the information-theoretic analogue of the inclusion-exclusion principle for set sizes.
</Remark>

## Data Processing Inequality

<Theorem id="thm-data-processing" name="Data Processing Inequality">
For a Markov chain $X \to Y \to Z$ (i.e., $X \perp Z \mid Y$, so $Z$ depends on $X$ only through $Y$):

<Equation id="eq-data-processing">

$$I(X; Z) \leq I(X; Y)$$

</Equation>

Processing data can only lose information, never create it. Equality holds iff $X \to Z \to Y$ is also a Markov chain (i.e., $Z$ is a sufficient statistic of $Y$ for $X$).
</Theorem>

<Remark id="rmk-data-processing-nn">
**Data processing inequality in neural networks.** In a neural network $X \to h_1 \to h_2 \to \cdots \to h_L \to \hat{Y}$, each layer forms a Markov chain, so:

$$I(X; \hat{Y}) \leq I(X; h_L) \leq \cdots \leq I(X; h_1) \leq I(X; X) = H(X)$$

**Implications:**
- Later layers cannot recover information lost by earlier layers. This motivates careful design of early layers and residual/skip connections (which break the Markov chain).
- **Information bottleneck theory** [@tishby2015deep] conjectures that training has two phases: (1) fitting, where $I(h; Y)$ increases; (2) compression, where $I(X; h)$ decreases, keeping only task-relevant information. This two-phase picture is empirically contested: [@saxe2018information] report that the compression phase depends on the activation nonlinearity and largely disappears for ReLU networks, so it should be read as a phenomenon observed in specific settings rather than a universal law.
- **Sufficient statistics:** If a layer $h_l$ is a sufficient statistic for $Y$ given $X$ (i.e., $I(h_l; Y) = I(X; Y)$), then no information about $Y$ has been lost. This is the ideal case.

Skip connections in ResNets violate the strict Markov chain structure, allowing $I(X; h_L)$ to remain close to $I(X; X)$ even in very deep networks.
</Remark>

## Rate-Distortion Theory

<Definition id="def-rate-distortion" name="Rate-Distortion Function">
The **rate-distortion function** $R(D)$ characterizes the minimum number of bits per sample needed to represent data from source $p(x)$ with average distortion at most $D$:

<Equation id="eq-rate-distortion">

$$R(D) = \min_{p(\hat{x}|x): \mathbb{E}[d(x,\hat{x})] \leq D} I(X; \hat{X})$$

</Equation>

where $d(x, \hat{x})$ is a distortion measure (e.g., MSE).
</Definition>

<Remark id="rmk-rate-distortion-ml">
**Rate-distortion and representation learning.** The information bottleneck objective

$$\min_Z I(X; Z) - \beta \cdot I(Z; Y)$$

is a rate-distortion problem: minimize the "rate" $I(X; Z)$ (compression) subject to acceptable "distortion" $I(Z; Y)$ (preserving task-relevant information). The Lagrange multiplier $\beta$ trades off compression vs. prediction quality. VAEs solve a related problem: the KL term $D_{\text{KL}}(q(z|x) \| p(z))$ upper-bounds the rate $I(X; Z)$ under the variational approximation.

Lossy compression, quantization, and knowledge distillation can all be framed as rate-distortion problems.
</Remark>

## Maximum Entropy Principle

<Definition id="def-max-entropy" name="Maximum Entropy Principle">
The **maximum entropy distribution** subject to constraints $\mathbb{E}_p[f_i(X)] = c_i$ is:

<Equation id="eq-max-entropy">

$$p^*(x) = \frac{1}{Z(\lambda)} h(x) \exp\left(\sum_i \lambda_i f_i(x)\right)$$

</Equation>

where $\lambda_i$ are Lagrange multipliers and $Z(\lambda)$ is the normalizing constant. This is exactly an exponential family distribution with sufficient statistics $f_i$.
</Definition>

<Remark id="rmk-max-entropy-principle">
**Maximum entropy and exponential families.** The maximum entropy principle provides a principled way to construct probability distributions when you know some statistics of the data but nothing else. The result is always an exponential family:

- Constraint on mean $\to$ exponential distribution
- Constraints on mean and variance $\to$ Gaussian
- Constraint on probabilities summing to 1 $\to$ uniform
- Constraint on mean of categorical $\to$ softmax (Boltzmann) distribution

This connects to statistical mechanics (Boltzmann distribution), information geometry (exponential families as maximum entropy), and ML (softmax as maximum entropy classifier).
</Remark>

## Notation Summary

<Table id="tab-notation-info" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $H(p)$ | Entropy of distribution $p$ |
| $h(p)$ | Differential entropy (continuous) |
| $H(p, q)$ | Cross-entropy between $p$ and $q$ |
| $D_{\text{KL}}(p \| q)$ | KL divergence from $q$ to $p$ |
| $D_f(p \| q)$ | $f$-divergence from $q$ to $p$ |
| $I(X; Y)$ | Mutual information between $X$ and $Y$ |
| $H(X|Y)$ | Conditional entropy of $X$ given $Y$ |
| $H(X,Y)$ | Joint entropy of $X$ and $Y$ |
| $R(D)$ | Rate-distortion function |
| $f^*$ | Convex conjugate of $f$ |
| PPL | Perplexity: $\exp(H_{\text{cross-entropy}})$ |
| $\log$ | Natural logarithm (nats) or $\log_2$ (bits) |

</Table>
