---
sidebar_position: 1
---

# Probability Basics

## Sample Space and Events

A **probability space** $(\Omega, \mathcal{F}, P)$ consists of:

- **Sample space** $\Omega$: the set of all possible outcomes
- **Event algebra** $\mathcal{F}$: a collection of subsets of $\Omega$ (events)
- **Probability measure** $P$: a function $P: \mathcal{F} \to [0, 1]$

## Axioms of Probability

(Kolmogorov, 1933):

1. $P(A) \geq 0$ for all events $A$
2. $P(\Omega) = 1$
3. For mutually exclusive events: $P(A_1 \cup A_2 \cup \cdots) = \sum_i P(A_i)$

From these axioms: $P(\bar{A}) = 1 - P(A)$, $P(A \cup B) = P(A) + P(B) - P(A \cap B)$.

## Conditional Probability and Bayes' Theorem

The probability of $A$ given $B$:

$$
P(A | B) = \frac{P(A \cap B)}{P(B)} = \frac{P(B | A) P(A)}{P(B)}
$$

**Bayes' theorem** inverts conditioning:

$$
P(\theta | \mathcal{D}) = \frac{P(\mathcal{D} | \theta) P(\theta)}{P(\mathcal{D})} = \frac{\text{likelihood} \times \text{prior}}{\text{evidence}}
$$

**Key insight:** Bayes' theorem is the foundation of Bayesian inference. The posterior $P(\theta | \mathcal{D})$ combines our prior belief $P(\theta)$ with the data evidence $P(\mathcal{D} | \theta)$. In ML, this underpins MAP estimation, Bayesian neural networks, and variational autoencoders.

## Independence

Events $A$ and $B$ are **independent** if $P(A \cap B) = P(A)P(B)$, equivalently $P(A|B) = P(A)$.

Random variables $X$ and $Y$ are independent if $P(X, Y) = P(X)P(Y)$ for all values. **Conditional independence** $X \perp Y | Z$ means $P(X, Y | Z) = P(X|Z)P(Y|Z)$.

## Expectation and Variance

The **expectation** (mean) of a random variable:

$$
\mathbb{E}[X] = \sum_x x \, P(X=x) \quad \text{(discrete)}, \quad \mathbb{E}[X] = \int x \, p(x) \, dx \quad \text{(continuous)}
$$

**Linearity of expectation** (always holds, even for dependent variables):

$$
\mathbb{E}[aX + bY] = a\mathbb{E}[X] + b\mathbb{E}[Y]
$$

The **variance** measures spread around the mean:

$$
\text{Var}(X) = \mathbb{E}[(X - \mu)^2] = \mathbb{E}[X^2] - (\mathbb{E}[X])^2
$$

$$
\text{Var}(aX + b) = a^2 \text{Var}(X)
$$

## Covariance and Correlation

The **covariance** measures linear dependence:

$$
\text{Cov}(X, Y) = \mathbb{E}[(X - \mu_X)(Y - \mu_Y)] = \mathbb{E}[XY] - \mathbb{E}[X]\mathbb{E}[Y]
$$

The **correlation coefficient** normalizes covariance to $[-1, 1]$:

$$
\rho(X, Y) = \frac{\text{Cov}(X, Y)}{\sqrt{\text{Var}(X)\text{Var}(Y)}}
$$

For a random vector $X \in \mathbb{R}^n$, the **covariance matrix** is $\Sigma_{ij} = \text{Cov}(X_i, X_j)$, which is symmetric and positive semi-definite.

**Key insight:** Independent variables have zero covariance, but zero covariance does not imply independence (only for Gaussians). Covariance captures linear relationships; mutual information captures all dependencies.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\Omega$ | Sample space |
| $P(A)$ | Probability of event $A$ |
| $P(A|B)$ | Conditional probability |
| $\mathbb{E}[X]$ | Expectation of $X$ |
| $\text{Var}(X)$ | Variance of $X$ |
| $\text{Cov}(X,Y)$ | Covariance of $X$ and $Y$ |
| $\Sigma$ | Covariance matrix |
| $\rho$ | Correlation coefficient |
| $X \perp Y$ | $X$ and $Y$ are independent |
