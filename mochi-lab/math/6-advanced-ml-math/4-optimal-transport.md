---
sidebar_position: 4
---

# Optimal Transport

## The Transport Problem

Given two probability distributions $\mu$ (source) and $\nu$ (target) over a space $\mathcal{X}$, **optimal transport** finds the cheapest way to transform $\mu$ into $\nu$.

Formally, find a **transport plan** $\gamma \in \Pi(\mu, \nu)$ (a joint distribution with marginals $\mu$ and $\nu$) that minimizes the total cost:

$$
\min_{\gamma \in \Pi(\mu, \nu)} \int_{\mathcal{X} \times \mathcal{X}} c(x, y) \, d\gamma(x, y)
$$

where $c(x, y)$ is the cost of moving mass from $x$ to $y$.

## Wasserstein Distance

The **$p$-Wasserstein distance** uses cost $c(x,y) = \|x - y\|^p$:

$$
W_p(\mu, \nu) = \left(\inf_{\gamma \in \Pi(\mu, \nu)} \int \|x - y\|^p \, d\gamma(x, y)\right)^{1/p}
$$

The 1-Wasserstein distance ($p=1$) is also called the **Earth Mover's Distance (EMD)**: the minimum "work" needed to move one pile of dirt into the shape of another.

**Key insight:** Unlike KL divergence, the Wasserstein distance is a true metric (symmetric, satisfies triangle inequality) and is well-defined even when distributions have non-overlapping supports. This makes it a better loss function for comparing distributions that may not overlap (e.g., in early GAN training).

## Kantorovich Duality

The **dual formulation** of the 1-Wasserstein distance is:

$$
W_1(\mu, \nu) = \sup_{\|f\|_L \leq 1} \left(\mathbb{E}_{x \sim \mu}[f(x)] - \mathbb{E}_{y \sim \nu}[f(y)]\right)
$$

where the supremum is over all 1-Lipschitz functions $f$ (functions with $|f(x) - f(y)| \leq \|x - y\|$).

**Key insight:** The dual replaces optimization over transport plans (high-dimensional joint distributions) with optimization over a single function. This is exactly what the Wasserstein GAN critic does: it learns a 1-Lipschitz function that maximally separates the real and generated distributions.

## Sinkhorn Algorithm

For discrete distributions with $n$ support points, optimal transport has $O(n^3 \log n)$ complexity. The **Sinkhorn algorithm** adds entropic regularization for faster computation:

$$
W_\epsilon(\mu, \nu) = \min_{\gamma \in \Pi(\mu, \nu)} \sum_{i,j} c_{ij} \gamma_{ij} + \epsilon \sum_{i,j} \gamma_{ij} \log \gamma_{ij}
$$

The solution has the form $\gamma_{ij}^* = u_i K_{ij} v_j$ where $K_{ij} = e^{-c_{ij}/\epsilon}$. The Sinkhorn iterations alternately normalize rows and columns:

$$
u \leftarrow \frac{a}{Kv}, \quad v \leftarrow \frac{b}{K^\top u}
$$

where $a, b$ are the marginal probability vectors. Convergence is linear with rate depending on $\epsilon$.

**Key insight:** The Sinkhorn algorithm reduces optimal transport to iterated matrix-vector multiplications, which are easily parallelized on GPUs. The entropic regularization $\epsilon$ trades off solution quality for computational speed; $\epsilon \to 0$ recovers exact OT.

## ML Applications

| Application | How OT is used |
|-------------|---------------|
| **Wasserstein GAN** | Critic approximates $W_1$ via Kantorovich duality |
| **Distribution matching** | Align source and target domains (domain adaptation) |
| **Generative models** | OT provides better training signals than KL for non-overlapping distributions |
| **Data augmentation** | Interpolate between distributions via displacement interpolation |
| **Fairness** | Measure distributional distance between demographic groups |

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\mu, \nu$ | Source and target distributions |
| $\gamma$ | Transport plan (coupling) |
| $\Pi(\mu, \nu)$ | Set of all couplings with marginals $\mu, \nu$ |
| $c(x, y)$ | Transport cost function |
| $W_p$ | $p$-Wasserstein distance |
| $\epsilon$ | Entropic regularization parameter |
| $K$ | Gibbs kernel $K_{ij} = e^{-c_{ij}/\epsilon}$ |
| EMD | Earth Mover's Distance ($W_1$) |
