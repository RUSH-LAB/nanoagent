---
sidebar_position: 4
---

# Optimal Transport

## The Transport Problem

<Definition id="def-optimal-transport" name="Optimal Transport">
Given two probability distributions $\mu$ (source) and $\nu$ (target) over a space $\mathcal{X}$, **optimal transport** finds the cheapest way to transform $\mu$ into $\nu$.

Formally, find a **transport plan** $\gamma \in \Pi(\mu, \nu)$ (a joint distribution with marginals $\mu$ and $\nu$) that minimizes the total cost:

<Equation id="eq-ot-problem">

$$\min_{\gamma \in \Pi(\mu, \nu)} \int_{\mathcal{X} \times \mathcal{X}} c(x, y) \, d\gamma(x, y)$$

</Equation>

where $c(x, y)$ is the cost of moving mass from $x$ to $y$.
</Definition>

## Wasserstein Distance

<Definition id="def-wasserstein" name="Wasserstein Distance">
The **$p$-Wasserstein distance** uses cost $c(x,y) = \|x - y\|^p$:

<Equation id="eq-wasserstein">

$$W_p(\mu, \nu) = \left(\inf_{\gamma \in \Pi(\mu, \nu)} \int \|x - y\|^p \, d\gamma(x, y)\right)^{1/p}$$

</Equation>

The 1-Wasserstein distance ($p=1$) is also called the **Earth Mover's Distance (EMD)**: the minimum "work" needed to move one pile of dirt into the shape of another.
</Definition>

<Remark id="rmk-wasserstein-vs-kl">
Unlike KL divergence, the Wasserstein distance is a true metric (symmetric, satisfies triangle inequality) and is well-defined even when distributions have non-overlapping supports. This makes it a better loss function for comparing distributions that may not overlap (e.g., in early GAN training).
</Remark>

## Kantorovich Duality

<Theorem id="thm-kantorovich" name="Kantorovich Duality">
The **dual formulation** of the 1-Wasserstein distance is:

<Equation id="eq-kantorovich-dual">

$$W_1(\mu, \nu) = \sup_{\|f\|_L \leq 1} \left(\mathbb{E}_{x \sim \mu}[f(x)] - \mathbb{E}_{y \sim \nu}[f(y)]\right)$$

</Equation>

where the supremum is over all 1-Lipschitz functions $f$ (functions with $|f(x) - f(y)| \leq \|x - y\|$).
</Theorem>

<Remark id="rmk-wgan-critic">
The dual replaces optimization over transport plans (high-dimensional joint distributions) with optimization over a single function. This is exactly what the Wasserstein GAN [@arjovsky2017wgan] critic does: it learns a 1-Lipschitz function that maximally separates the real and generated distributions.
</Remark>

## Sinkhorn Algorithm

<Algorithm id="alg-sinkhorn" caption="Sinkhorn Algorithm for Entropic Optimal Transport">

**Input:** cost matrix $C$, marginals $a, b$, regularization $\epsilon$

1. Compute Gibbs kernel: $K_{ij} = e^{-C_{ij}/\epsilon}$
2. Initialize $v = \mathbf{1}$
3. **for** $\ell = 1, 2, \ldots$ until convergence **do**
4. &nbsp;&nbsp;&nbsp;&nbsp;$u \leftarrow a \oslash (Kv)$
5. &nbsp;&nbsp;&nbsp;&nbsp;$v \leftarrow b \oslash (K^\top u)$
6. **end for**

**Output:** transport plan $\gamma_{ij}^* = u_i K_{ij} v_j$

</Algorithm>

The entropic-regularized objective is:

<Equation id="eq-sinkhorn-obj">

$$W_\epsilon(\mu, \nu) = \min_{\gamma \in \Pi(\mu, \nu)} \sum_{i,j} c_{ij} \gamma_{ij} + \epsilon \sum_{i,j} \gamma_{ij} \log \gamma_{ij}$$

</Equation>

Convergence is linear with rate depending on $\epsilon$.

<Remark id="rmk-sinkhorn-gpu">
The Sinkhorn algorithm reduces optimal transport to iterated matrix-vector multiplications, which are easily parallelized on GPUs. The entropic regularization $\epsilon$ trades off solution quality for computational speed; $\epsilon \to 0$ recovers exact OT.
</Remark>

## ML Applications

<Table id="tab-ot-applications" caption="Applications of optimal transport in machine learning.">

| Application | How OT is used |
|-------------|---------------|
| **Wasserstein GAN** | Critic approximates $W_1$ via Kantorovich duality |
| **Distribution matching** | Align source and target domains (domain adaptation) |
| **Generative models** | OT provides better training signals than KL for non-overlapping distributions |
| **Data augmentation** | Interpolate between distributions via displacement interpolation |
| **Fairness** | Measure distributional distance between demographic groups |

</Table>

## Notation Summary

<Table id="tab-notation-ot" caption="Notation used in optimal transport.">

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

</Table>
