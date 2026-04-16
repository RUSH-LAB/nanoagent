---
sidebar_position: 4
---

# Optimal Transport

Optimal transport (OT) is the mathematical theory of moving mass efficiently between distributions. It provides geometrically meaningful distances between probability distributions that, unlike KL divergence, respect the underlying geometry of the sample space. In machine learning, OT appears in generative models (Wasserstein GANs), domain adaptation, fairness, and increasingly as a foundation for modern generative frameworks like flow matching and rectified flows.

## The Transport Problem

<Definition id="def-optimal-transport" name="Optimal Transport (Monge and Kantorovich)">
Given two probability distributions $\mu$ (source) and $\nu$ (target) over a space $\mathcal{X}$:

**Monge formulation** (1781): Find a transport *map* $T: \mathcal{X} \to \mathcal{X}$ that pushes $\mu$ forward to $\nu$ (i.e., $T_\# \mu = \nu$, meaning $\nu(B) = \mu(T^{-1}(B))$ for all measurable $B$) and minimizes:

$$\inf_{T: T_\# \mu = \nu} \int c(x, T(x)) \, d\mu(x)$$

**Kantorovich formulation** (1942): Relax to a transport *plan* $\gamma \in \Pi(\mu, \nu)$ -- a joint distribution with marginals $\mu$ and $\nu$ -- that allows mass splitting:

<Equation id="eq-ot-problem">

$$\min_{\gamma \in \Pi(\mu, \nu)} \int_{\mathcal{X} \times \mathcal{X}} c(x, y) \, d\gamma(x, y)$$

</Equation>

where $c(x, y)$ is the cost of moving a unit of mass from $x$ to $y$, and $\Pi(\mu, \nu) = \{\gamma : \int \gamma(x, y) dy = \mu(x), \int \gamma(x, y) dx = \nu(y)\}$.
</Definition>

<Remark id="rmk-monge-vs-kantorovich">
**Monge vs. Kantorovich.** Monge's formulation requires a deterministic map (each source point goes to exactly one destination), which may not exist (e.g., transporting a point mass to two point masses). Kantorovich's relaxation always has a solution and is a linear program. When the cost is $c(x,y) = \|x-y\|^2$ and $\mu$ is absolutely continuous, the Monge and Kantorovich solutions coincide: the optimal plan is supported on the graph of a map $T^*(x) = x - \nabla \phi(x)$ where $\phi$ is a convex function (Brenier's theorem).
</Remark>

## Wasserstein Distance

<Definition id="def-wasserstein" name="Wasserstein Distance">
The **$p$-Wasserstein distance** uses cost $c(x,y) = \|x - y\|^p$:

<Equation id="eq-wasserstein">

$$W_p(\mu, \nu) = \left(\inf_{\gamma \in \Pi(\mu, \nu)} \int \|x - y\|^p \, d\gamma(x, y)\right)^{1/p}$$

</Equation>

The 1-Wasserstein distance ($p=1$) is also called the **Earth Mover's Distance (EMD)**: the minimum "work" (mass $\times$ distance) needed to reshape one pile of dirt into another. The 2-Wasserstein distance ($p=2$) has nicer geometric properties and connections to optimal maps.
</Definition>

<Remark id="rmk-wasserstein-vs-kl">
**Why Wasserstein is better than KL for some tasks.**

| Property | KL Divergence | Wasserstein Distance |
|----------|--------------|---------------------|
| Metric? | No (asymmetric, no triangle ineq.) | Yes (symmetric, triangle ineq.) |
| Non-overlapping support | $D_{\text{KL}} = \infty$ | Finite (uses geometry) |
| Sensitivity to geometry | None (only ratios $p/q$) | Respects distances in $\mathcal{X}$ |
| Gradient quality | Vanishes when supports don't overlap | Always provides useful gradients |
| Computation | $O(n)$ (sample-based) | $O(n^3)$ exact, $O(n^2/\epsilon^2)$ entropic |

The key advantage: when $\mu$ and $\nu$ have disjoint supports (common early in GAN training when the generator produces images far from real data), KL divergence is infinite and provides no gradient signal. Wasserstein distance is finite and provides a meaningful gradient pointing $\mu$ toward $\nu$.
</Remark>

<Example id="ex-wasserstein-1d">
**1D Wasserstein.** In one dimension, the Wasserstein distance has a beautiful closed form:

$$W_p(\mu, \nu) = \left(\int_0^1 |F_\mu^{-1}(t) - F_\nu^{-1}(t)|^p \, dt\right)^{1/p}$$

where $F^{-1}$ is the quantile function (inverse CDF). For $p = 1$: $W_1 = \int_{-\infty}^{\infty} |F_\mu(x) - F_\nu(x)| dx$. The optimal transport map is $T = F_\nu^{-1} \circ F_\mu$ (map quantiles to quantiles). This is why 1D optimal transport is $O(n \log n)$ (just sort and pair up).
</Example>

<Example id="ex-wasserstein-gaussians">
**Wasserstein between Gaussians.** For $\mu = \mathcal{N}(m_1, \Sigma_1)$ and $\nu = \mathcal{N}(m_2, \Sigma_2)$, the 2-Wasserstein distance has a closed form (the **Bures metric**):

<Equation id="eq-bures">

$$W_2^2(\mu, \nu) = \|m_1 - m_2\|^2 + \text{tr}\left(\Sigma_1 + \Sigma_2 - 2\left(\Sigma_1^{1/2} \Sigma_2 \Sigma_1^{1/2}\right)^{1/2}\right)$$

</Equation>

For diagonal covariances: $W_2^2 = \|m_1 - m_2\|^2 + \sum_i (\sigma_{1,i} - \sigma_{2,i})^2$. This is used in the FID (Frechet Inception Distance) metric for evaluating generative models, where the Inception features of real and generated images are modeled as Gaussians.
</Example>

## Kantorovich Duality

<Theorem id="thm-kantorovich" name="Kantorovich Duality">
The **dual formulation** of the 1-Wasserstein distance is:

<Equation id="eq-kantorovich-dual">

$$W_1(\mu, \nu) = \sup_{\|f\|_L \leq 1} \left(\mathbb{E}_{x \sim \mu}[f(x)] - \mathbb{E}_{y \sim \nu}[f(y)]\right)$$

</Equation>

where the supremum is over all **1-Lipschitz functions** $f$ (satisfying $|f(x) - f(y)| \leq \|x - y\|$ for all $x, y$).

More generally, for cost $c(x,y)$, the dual is:

$$\sup_{\phi, \psi} \left\{\mathbb{E}_\mu[\phi(x)] + \mathbb{E}_\nu[\psi(y)] : \phi(x) + \psi(y) \leq c(x,y) \; \forall x, y\right\}$$

where $(\phi, \psi)$ are **Kantorovich potentials**. For $c = \|x-y\|$, the constraint forces $\phi = -\psi$ and $\phi$ to be 1-Lipschitz.
</Theorem>

<Remark id="rmk-wgan-critic">
**From duality to WGAN.** The Kantorovich dual replaces optimization over transport plans (high-dimensional joint distributions) with optimization over a single function. This is exactly what the **Wasserstein GAN (WGAN)** [@arjovsky2017wgan] exploits:

- **Critic (discriminator):** Parameterize a 1-Lipschitz function $f_\omega$ and maximize $\mathbb{E}_{x \sim p_{\text{data}}}[f_\omega(x)] - \mathbb{E}_{z \sim p_z}[f_\omega(G_\theta(z))]$.
- **Generator:** Minimize the same objective (push generated samples closer to real data in Wasserstein sense).

The Lipschitz constraint is enforced via:
- **Weight clipping** (original WGAN): Clip $\omega \in [-c, c]$. Simple but biases toward simple functions.
- **Gradient penalty** (WGAN-GP) [@gulrajani2017improved]: Add $\lambda \mathbb{E}[(\|\nabla f_\omega(\hat{x})\| - 1)^2]$ where $\hat{x}$ interpolates between real and fake samples. More stable.
- **Spectral normalization** [@miyato2018spectral]: Normalize weight matrices by their spectral norm. Efficient and widely used.
</Remark>

## Entropic Optimal Transport

<Definition id="def-entropic-ot" name="Entropic Optimal Transport">
Adding an **entropic regularization** term makes OT computationally tractable:

<Equation id="eq-sinkhorn-obj">

$$W_\epsilon(\mu, \nu) = \min_{\gamma \in \Pi(\mu, \nu)} \sum_{i,j} c_{ij} \gamma_{ij} + \epsilon \sum_{i,j} \gamma_{ij} \log \gamma_{ij}$$

</Equation>

The entropy term $\epsilon H(\gamma)$ encourages the transport plan to spread out (higher entropy = more diffuse plan). As $\epsilon \to 0$, $W_\epsilon \to W$ (exact OT). As $\epsilon \to \infty$, the plan approaches the independent coupling $\gamma = \mu \otimes \nu$.
</Definition>

<Algorithm id="alg-sinkhorn" caption="Sinkhorn Algorithm for Entropic Optimal Transport">

**Input:** Cost matrix $C \in \mathbb{R}^{n \times m}$, marginals $a \in \Delta^{n-1}$, $b \in \Delta^{m-1}$, regularization $\epsilon > 0$

1. Compute Gibbs kernel: $K_{ij} = \exp(-C_{ij}/\epsilon)$
2. Initialize: $v = \mathbf{1}_m$
3. **for** $\ell = 1, 2, \ldots$ until convergence **do**
4. &nbsp;&nbsp;&nbsp;&nbsp;$u \leftarrow a \oslash (Kv)$ &nbsp;&nbsp;&nbsp;&nbsp;(row normalization: $u_i = a_i / \sum_j K_{ij} v_j$)
5. &nbsp;&nbsp;&nbsp;&nbsp;$v \leftarrow b \oslash (K^\top u)$ &nbsp;&nbsp;&nbsp;&nbsp;(column normalization: $v_j = b_j / \sum_i K_{ij} u_i$)
6. **end for**

**Output:** Transport plan $\gamma^*_{ij} = u_i K_{ij} v_j$, cost $W_\epsilon = \langle C, \gamma^* \rangle$

</Algorithm>

<Remark id="rmk-sinkhorn-properties">
**Sinkhorn algorithm properties:**

- **Convergence:** Linear rate $O((1-\delta)^\ell)$ where $\delta$ depends on $\epsilon$ and the cost matrix. Smaller $\epsilon$ means slower convergence but more accurate OT.
- **GPU-friendly:** Each iteration is a matrix-vector multiply $Kv$ and elementwise operations -- perfectly suited for GPU parallelism. For $n$ points, each iteration is $O(n^2)$.
- **Differentiable:** Both the forward and backward passes are differentiable, enabling end-to-end learning with OT losses. Automatic differentiation through the Sinkhorn iterations is straightforward.
- **Log-domain stability:** For small $\epsilon$, the kernel $K$ has entries close to 0 or very large. Computing in log-domain: $\log u, \log v, \log K$ avoids numerical underflow/overflow.
- **Minibatch Sinkhorn:** For large-scale problems, compute Sinkhorn on random minibatches of source and target points. This gives a biased but useful estimator.
</Remark>

## Optimal Transport Maps and Displacement Interpolation

<Definition id="def-displacement-interpolation" name="Displacement Interpolation">
Given the optimal transport map $T^*$ from $\mu$ to $\nu$, the **displacement interpolation** (McCann interpolation) defines a geodesic path between distributions:

<Equation id="eq-displacement-interpolation">

$$\mu_t = ((1-t)\text{Id} + tT^*)_\# \mu, \quad t \in [0, 1]$$

</Equation>

At $t = 0$: $\mu_0 = \mu$. At $t = 1$: $\mu_1 = \nu$. Each intermediate $\mu_t$ moves mass along the optimal transport paths, creating a natural interpolation in distribution space.
</Definition>

<Remark id="rmk-ot-interpolation-ml">
**Displacement interpolation in generative models.** Flow matching [@lipman2023flow] and rectified flows [@liu2023flow] learn the velocity field of the displacement interpolation:

$$x_t = (1-t)x_0 + t x_1 \quad \text{where } x_0 \sim \mu \text{ (noise)}, \; x_1 \sim \nu \text{ (data)}$$

The velocity field $v_t(x) = x_1 - x_0$ produces straight-line trajectories from noise to data. Training the model $v_\theta(x_t, t) \approx x_1 - x_0$ with MSE loss gives the flow matching objective. This is simpler than diffusion (no noise schedule, no SDE/ODE theory) and produces straighter flows that require fewer sampling steps.

The connection to OT: if $(x_0, x_1)$ are coupled via the optimal transport plan (rather than independently), the trajectories are non-crossing and the learned velocity field is smoother, leading to better generation quality.
</Remark>

## Wasserstein Barycenters

<Definition id="def-wasserstein-barycenter" name="Wasserstein Barycenter">
The **Wasserstein barycenter** of distributions $\mu_1, \ldots, \mu_K$ with weights $\lambda_1, \ldots, \lambda_K$ is:

<Equation id="eq-barycenter">

$$\bar{\mu} = \arg\min_\mu \sum_{k=1}^K \lambda_k W_2^2(\mu, \mu_k)$$

</Equation>

The barycenter is the "average" distribution in the Wasserstein sense, which preserves geometric structure better than mixture-based averaging.
</Definition>

<Remark id="rmk-barycenter-applications">
**Applications:** Wasserstein barycenters are used for texture mixing, shape interpolation, multi-source domain adaptation (average the source domains into a barycenter, then adapt to the target), and aggregating predictions from multiple generative models. The entropic-regularized barycenter can be computed via iterative Sinkhorn projections.
</Remark>

## ML Applications

<Table id="tab-ot-applications" caption="Applications of optimal transport in machine learning.">

| Application | How OT is Used | Key Advantage |
|-------------|---------------|---------------|
| **Wasserstein GAN** | Critic approximates $W_1$ via Kantorovich duality | Stable training, meaningful loss |
| **Flow matching** | OT coupling gives straight trajectories | Few-step generation |
| **Domain adaptation** | Minimize $W_2$ between source and target features | Geometry-aware alignment |
| **FID score** | $W_2^2$ between Gaussians fit to Inception features | Standard generative model metric |
| **Distributional RL** | Model return as a distribution; use $W_p$ for comparison | Preserves return distribution shape |
| **Fairness** | $W_1$ between demographic group distributions | Measure and mitigate distributional disparity |
| **Data augmentation** | Displacement interpolation between classes | Meaningful between-class interpolation |
| **Sliced Wasserstein** | $\mathbb{E}_\theta[W_1(\text{proj}_\theta \mu, \text{proj}_\theta \nu)]$ | Scalable: 1D OT on random projections |
| **Graph matching** | OT between node feature distributions | Permutation-invariant comparison |
| **Point cloud registration** | OT map aligns two point sets | Correspondence without labels |

</Table>

<Remark id="rmk-computational-ot">
**Computational complexity of OT.**

| Method | Complexity | Accuracy | Use Case |
|--------|-----------|----------|----------|
| Exact (linear program) | $O(n^3 \log n)$ | Exact | Small problems ($n < 1000$) |
| Sinkhorn (entropic) | $O(n^2 / \epsilon^2)$ | $\epsilon$-approximate | Medium problems, differentiable |
| Sliced Wasserstein | $O(Ln\log n)$ ($L$ projections) | Approximation | Large-scale, any dimension |
| Minibatch Sinkhorn | $O(b^2)$ per batch | Biased estimator | Very large scale |
| Neural OT | $O(\text{forward pass})$ | Amortized | Continuous distributions |

For high-dimensional problems, **sliced Wasserstein** computes $W_1$ on random 1D projections (where OT is just sorting) and averages. This avoids the curse of dimensionality and scales to millions of points.
</Remark>

## Notation Summary

<Table id="tab-notation-ot" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\mu, \nu$ | Source and target distributions |
| $\gamma$ | Transport plan (coupling) |
| $T$ | Transport map (Monge) |
| $T_\# \mu$ | Pushforward of $\mu$ by $T$ |
| $\Pi(\mu, \nu)$ | Set of all couplings with marginals $\mu, \nu$ |
| $c(x, y)$ | Transport cost function |
| $W_p$ | $p$-Wasserstein distance |
| $\epsilon$ | Entropic regularization parameter |
| $K$ | Gibbs kernel: $K_{ij} = e^{-c_{ij}/\epsilon}$ |
| $u, v$ | Sinkhorn scaling vectors |
| $\phi, \psi$ | Kantorovich dual potentials |
| $\bar{\mu}$ | Wasserstein barycenter |
| EMD | Earth Mover's Distance ($W_1$) |
| FID | Frechet Inception Distance (Bures-$W_2$) |

</Table>
