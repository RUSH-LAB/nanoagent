---
sidebar_position: 1
---

# Probability Basics

Probability theory provides the mathematical framework for reasoning under uncertainty, the other foundational language of machine learning alongside linear algebra. Every ML model makes probabilistic assumptions (implicitly or explicitly), and understanding probability is essential for designing, training, and interpreting models.

## Sample Space and Events

<Definition id="def-prob-space" name="Probability Space">
A **probability space** $(\Omega, \mathcal{F}, P)$ consists of:

- **Sample space** $\Omega$: the set of all possible outcomes of an experiment
- **Event algebra** $\mathcal{F}$: a $\sigma$-algebra, a collection of subsets of $\Omega$ closed under complement and countable union
- **Probability measure** $P: \mathcal{F} \to [0, 1]$: a function assigning probabilities to events
</Definition>

<Example id="ex-prob-spaces-ml">
**Probability spaces in ML:**
- **Classification:** $\Omega = \{1, 2, \ldots, K\}$ (class labels), $P$ given by the softmax output
- **Language modeling:** $\Omega = \mathcal{V}^T$ (all sequences of length $T$ over vocabulary $\mathcal{V}$), $P(x_1, \ldots, x_T) = \prod_t P(x_t \mid x_{\lt t})$
- **Bayesian inference:** $\Omega = \Theta$ (parameter space), $P$ is the posterior distribution
</Example>

## Axioms of Probability

<Definition id="def-kolmogorov-axioms" name="Kolmogorov Axioms">
All of probability theory follows from three axioms [@kolmogorov1933foundations]:

1. **Non-negativity:** $P(A) \geq 0$ for all events $A$
2. **Normalization:** $P(\Omega) = 1$
3. **Countable additivity:** For mutually exclusive events $A_1, A_2, \ldots$: $P\!\left(\bigcup_i A_i\right) = \sum_i P(A_i)$
</Definition>

From these axioms, all other rules follow:
- $P(\bar{A}) = 1 - P(A)$ (complement)
- $P(A \cup B) = P(A) + P(B) - P(A \cap B)$ (inclusion-exclusion)
- $P(\emptyset) = 0$
- If $A \subseteq B$, then $P(A) \leq P(B)$ (monotonicity)

## Conditional Probability and Bayes' Theorem

<Definition id="def-conditional-prob" name="Conditional Probability">
The probability of $A$ given that $B$ has occurred:

$$P(A | B) = \frac{P(A \cap B)}{P(B)}, \quad P(B) > 0$$

This defines a new probability measure $P(\cdot | B)$ that concentrates on the event $B$.
</Definition>

<Theorem id="thm-bayes" name="Bayes' Theorem">
**Bayes' theorem** inverts the direction of conditioning:

<Equation id="eq-bayes">

$$P(\theta | \mathcal{D}) = \frac{P(\mathcal{D} | \theta) \, P(\theta)}{P(\mathcal{D})} = \frac{\text{likelihood} \times \text{prior}}{\text{evidence}}$$

</Equation>

where $P(\mathcal{D}) = \sum_\theta P(\mathcal{D}|\theta)P(\theta)$ (discrete) or $\int P(\mathcal{D}|\theta)P(\theta)d\theta$ (continuous) is the **marginal likelihood** (evidence).
</Theorem>

<Remark id="rmk-bayes-ml">
Bayes' theorem is the engine of Bayesian machine learning:

| Component | Interpretation in ML |
|-----------|---------------------|
| $P(\theta)$ (prior) | Our belief about model parameters before seeing data (e.g., Gaussian $\to$ L2 regularization) |
| $P(\mathcal{D}|\theta)$ (likelihood) | How well the model with parameters $\theta$ explains the training data |
| $P(\theta|\mathcal{D})$ (posterior) | Updated belief after incorporating data; used for prediction and uncertainty |
| $P(\mathcal{D})$ (evidence) | Model quality score for model comparison; intractable for neural networks |

MAP estimation maximizes $P(\theta|\mathcal{D})$, which reduces to maximizing the log-likelihood plus a log-prior penalty (a regularizer). Full Bayesian inference integrates over $P(\theta|\mathcal{D})$, giving calibrated uncertainty.
</Remark>

<Example id="ex-bayes-spam">
**Spam classification with Bayes' theorem.** Suppose 20% of emails are spam ($P(S) = 0.2$). The word "free" appears in 80% of spam and 10% of non-spam emails: $P(\text{free}|S) = 0.8$, $P(\text{free}|\bar{S}) = 0.1$. Given an email containing "free," what is the probability it is spam?

$$P(S|\text{free}) = \frac{P(\text{free}|S) \cdot P(S)}{P(\text{free})} = \frac{0.8 \times 0.2}{0.8 \times 0.2 + 0.1 \times 0.8} = \frac{0.16}{0.24} = \frac{2}{3} \approx 0.67$$

The prior probability of spam (20%) is updated to 67% after observing "free." This is the foundation of Naive Bayes classifiers, which assume features are conditionally independent given the class: $P(x_1, \ldots, x_n | y) = \prod_i P(x_i | y)$.
</Example>

<Theorem id="thm-total-probability" name="Law of Total Probability">
For a partition $\{B_1, B_2, \ldots, B_n\}$ of $\Omega$:

$$P(A) = \sum_{i=1}^n P(A | B_i) P(B_i)$$

This is the "denominator" in Bayes' theorem and is used in marginalization: $P(x) = \sum_z P(x|z)P(z)$.
</Theorem>

<Example id="ex-total-probability-defect">
**Marginalizing over a hidden cause.** A factory runs two machines. Machine $B_1$ produces 70% of items with a 2% defect rate; machine $B_2$ produces the remaining 30% with a 5% defect rate. What fraction of items are defective?

Apply the law of total probability over the partition $\{B_1, B_2\}$, with $A$ the event "item is defective":

$$P(A) = P(A | B_1)P(B_1) + P(A | B_2)P(B_2)$$

The conditional defect rates and machine shares are given, so substitute directly:

$$P(A) = 0.02 \times 0.70 + 0.05 \times 0.30 = 0.014 + 0.015 = 0.029$$

So 2.9% of items are defective. To go the other way and ask which machine most likely produced a defective item, plug this denominator into Bayes' theorem:

$$P(B_2 | A) = \frac{P(A | B_2)P(B_2)}{P(A)} = \frac{0.015}{0.029} \approx 0.52$$

Even though $B_2$ makes only 30% of items, its higher defect rate means it accounts for just over half of all defects.
</Example>

## Independence

<Definition id="def-independence" name="Independence">
Events $A$ and $B$ are **independent** ($A \perp B$) if $P(A \cap B) = P(A)P(B)$, equivalently $P(A|B) = P(A)$.

Random variables $X$ and $Y$ are **independent** if $P(X \in S, Y \in T) = P(X \in S) \cdot P(Y \in T)$ for all measurable sets $S, T$. Equivalently, the joint density factors: $p(x, y) = p(x)p(y)$.

**Conditional independence:** $X \perp Y | Z$ means $p(x, y | z) = p(x|z) \cdot p(y|z)$. This is central to graphical models: nodes in a Bayesian network are conditionally independent given their parents.
</Definition>

<Remark id="rmk-iid">
The **i.i.d. assumption** (independent and identically distributed) is the most common assumption in ML: training examples $(x_i, y_i)$ are assumed drawn independently from the same distribution $P$. This enables:
- The law of large numbers: $\hat{R}(h) \to R(h)$ as $n \to \infty$
- Concentration inequalities: $|\hat{R}(h) - R(h)| = O(1/\sqrt{n})$
- The validity of cross-validation

The i.i.d. assumption breaks in time series, reinforcement learning, and distribution shift settings.
</Remark>

## Expectation and Variance

<Definition id="def-expectation" name="Expectation">
The **expectation** (mean) of a random variable $X$ with respect to distribution $p$:

<Equation id="eq-expectation">

$$\mathbb{E}[X] = \sum_x x \, p(x) \quad \text{(discrete)}, \qquad \mathbb{E}[X] = \int x \, p(x) \, dx \quad \text{(continuous)}$$

</Equation>

For a function $g(X)$: $\mathbb{E}[g(X)] = \sum_x g(x) p(x)$ (LOTUS: Law of the Unconscious Statistician).
</Definition>

**Key properties:**

1. **Linearity** (always, even for dependent variables): $\mathbb{E}[aX + bY] = a\mathbb{E}[X] + b\mathbb{E}[Y]$
2. **Product rule for independent variables:** If $X \perp Y$, then $\mathbb{E}[XY] = \mathbb{E}[X]\mathbb{E}[Y]$
3. **Jensen's inequality** (for convex $g$): $g(\mathbb{E}[X]) \leq \mathbb{E}[g(X)]$

<Remark id="rmk-jensen-ml">
**Jensen's inequality** appears throughout ML:
- **Why log-likelihood is the training objective:** $\log \mathbb{E}[X] \geq \mathbb{E}[\log X]$ (concave $\log$) gives the ELBO
- **Why KL divergence is non-negative:** Apply Jensen to $\mathbb{E}_p[\log(q/p)] \leq \log \mathbb{E}_p[q/p] = 0$
- **Why the average model is better than the average prediction:** Ensemble methods exploit convexity of the loss
</Remark>

<Definition id="def-variance" name="Variance and Standard Deviation">
The **variance** measures the expected squared deviation from the mean:

<Equation id="eq-variance">

$$\text{Var}(X) = \mathbb{E}[(X - \mathbb{E}[X])^2] = \mathbb{E}[X^2] - (\mathbb{E}[X])^2$$

</Equation>

The **standard deviation** is $\text{Std}(X) = \sqrt{\text{Var}(X)}$. Properties:

$$\text{Var}(aX + b) = a^2 \text{Var}(X), \qquad \text{Var}(X + Y) = \text{Var}(X) + \text{Var}(Y) + 2\text{Cov}(X,Y)$$

For independent $X, Y$: $\text{Var}(X + Y) = \text{Var}(X) + \text{Var}(Y)$.
</Definition>

## Covariance and Correlation

<Definition id="def-covariance" name="Covariance and Correlation">
The **covariance** between random variables $X$ and $Y$ measures their linear dependence:

<Equation id="eq-covariance">

$$\text{Cov}(X, Y) = \mathbb{E}[(X - \mu_X)(Y - \mu_Y)] = \mathbb{E}[XY] - \mathbb{E}[X]\mathbb{E}[Y]$$

</Equation>

The **Pearson correlation coefficient** normalizes covariance to $[-1, 1]$:

$$\rho(X, Y) = \frac{\text{Cov}(X, Y)}{\text{Std}(X) \cdot \text{Std}(Y)}$$

$|\rho| = 1$ iff $X$ and $Y$ are linearly related; $\rho = 0$ means uncorrelated.
</Definition>

For a random vector $X \in \mathbb{R}^n$, the **covariance matrix** is $\Sigma \in \mathbb{R}^{n \times n}$ with $\Sigma_{ij} = \text{Cov}(X_i, X_j)$. This matrix is always symmetric and positive semi-definite ($z^\top \Sigma z = \text{Var}(z^\top X) \geq 0$).

<Remark id="rmk-covariance-independence">
**Correlation $\neq$ independence.** Uncorrelated ($\text{Cov}(X,Y) = 0$) means no *linear* relationship. Independent means no relationship of *any kind*. For Gaussian random variables, uncorrelated *does* imply independent (a unique property of the Gaussian). For other distributions, $X$ and $Y$ can be uncorrelated yet strongly dependent (e.g., $Y = X^2$ for symmetric $X$).
</Remark>

## Concentration Inequalities

<Theorem id="thm-concentration" name="Key Concentration Inequalities">
These bound the probability that a random variable deviates from its mean:

<Table id="tab-concentration" caption="Concentration inequalities used in ML theory.">

| Inequality | Statement | Conditions |
|-----------|-----------|-----------|
| **Markov** | $P(X \geq a) \leq \mathbb{E}[X]/a$ | $X \geq 0$, $a > 0$ |
| **Chebyshev** | $P(|X - \mu| \geq k\sigma) \leq 1/k^2$ | Finite variance |
| **Hoeffding** | $P(|\bar{X}_n - \mu| \geq t) \leq 2e^{-2nt^2/(b-a)^2}$ | $X_i \in [a,b]$, independent |
| **Bernstein** | $P(|\bar{X}_n - \mu| \geq t) \leq 2\exp(-\frac{nt^2/2}{\sigma^2 + bt/3})$ | $|X_i - \mu| \leq b$, independent |

</Table>

</Theorem>

<Remark id="rmk-hoeffding-generalization">
**Hoeffding's inequality and generalization.** For a finite hypothesis class $\mathcal{H}$ with $|\mathcal{H}|$ members and bounded loss $\ell \in [0, 1]$, a union bound over Hoeffding gives:

$$P\!\left(\sup_{h \in \mathcal{H}} |R(h) - \hat{R}(h)| \geq t\right) \leq 2|\mathcal{H}| e^{-2nt^2}$$

Setting the RHS $= \delta$ and solving for $t$: the generalization gap is at most $\sqrt{\frac{\log(2|\mathcal{H}|/\delta)}{2n}}$ with probability $\geq 1-\delta$. This is the foundation of PAC learning bounds.
</Remark>

## Notation Summary

<Table id="tab-notation-prob" caption="Notation used in this section.">

| Symbol | Meaning |
|--------|---------|
| $\Omega$ | Sample space |
| $\mathcal{F}$ | $\sigma$-algebra (event space) |
| $P(A)$ | Probability of event $A$ |
| $P(A \mid B)$ | Conditional probability of $A$ given $B$ |
| $\mathbb{E}[X]$ | Expectation of $X$ |
| $\text{Var}(X)$ | Variance of $X$ |
| $\text{Cov}(X,Y)$ | Covariance of $X$ and $Y$ |
| $\Sigma$ | Covariance matrix |
| $\rho$ | Correlation coefficient |
| $X \perp Y$ | $X$ and $Y$ are independent |
| $X \perp Y \mid Z$ | Conditional independence given $Z$ |
| i.i.d. | Independent and identically distributed |

</Table>
