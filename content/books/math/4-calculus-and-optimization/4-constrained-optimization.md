---
sidebar_position: 4
---

# Constrained Optimization

Many ML problems involve optimizing subject to constraints, from SVMs with margin constraints to RLHF with KL penalties to fairness constraints in responsible AI. The Lagrangian framework transforms these constrained problems into unconstrained ones, enabling gradient-based solutions.

## The Constrained Problem

<Definition id="def-constrained-problem" name="General Constrained Optimization">
The standard form of a constrained optimization problem is:

<Equation id="eq-constrained-opt">

$$\min_{x \in \mathbb{R}^n} f(x) \quad \text{subject to} \quad g_i(x) \leq 0, \; i = 1, \dots, m \quad \text{and} \quad h_j(x) = 0, \; j = 1, \dots, p$$

</Equation>

where $f$ is the **objective function**, $g_i$ are **inequality constraints**, and $h_j$ are **equality constraints**. The set of points satisfying all constraints is the **feasible set**.
</Definition>

<Example id="ex-constrained-examples">
**Constrained problems in ML:**
- **SVM:** $\min \frac{1}{2}\|w\|^2$ s.t. $y_i(w^\top x_i + b) \geq 1$
- **Trust region:** $\min \nabla f^\top \delta + \frac{1}{2}\delta^\top H \delta$ s.t. $\|\delta\| \leq \Delta$
- **Simplex constraint:** $\min f(\pi)$ s.t. $\pi \geq 0$, $\sum_i \pi_i = 1$ (e.g., mixture weights)
- **Spectral norm constraint:** $\min \mathcal{L}(\theta)$ s.t. $\|W_l\|_2 \leq c$ for each layer
</Example>

## Lagrange Multipliers (Equality Constraints)

<Definition id="def-lagrangian-eq" name="Lagrangian for Equality Constraints">
For $\min_x f(x)$ subject to $h(x) = 0$ where $h: \mathbb{R}^n \to \mathbb{R}^p$, introduce **Lagrange multipliers** $\nu \in \mathbb{R}^p$ and form the **Lagrangian**:

<Equation id="eq-lagrangian-eq">

$$\mathcal{L}(x, \nu) = f(x) + \nu^\top h(x) = f(x) + \sum_{j=1}^p \nu_j h_j(x)$$

</Equation>

The necessary conditions for optimality are:

$$\nabla_x \mathcal{L} = \nabla f(x^*) + \sum_j \nu_j^* \nabla h_j(x^*) = 0 \qquad \text{and} \qquad h(x^*) = 0$$
</Definition>

<Remark id="rmk-lagrange-geometry">
**Geometric interpretation.** At a constrained optimum $x^*$, the gradient of $f$ must be a linear combination of the constraint gradients. If $\nabla f$ had a component tangent to the constraint surface $h(x) = 0$, we could move along that surface and decrease $f$, contradicting optimality. Therefore $\nabla f = -\sum_j \nu_j \nabla h_j$, meaning $\nabla f$ is normal to the constraint surface.
</Remark>

<Remark id="rmk-multiplier-sensitivity">
**Sensitivity interpretation.** The Lagrange multiplier $\nu_j^*$ measures the sensitivity of the optimal objective value to the constraint. If we relax the constraint from $h_j(x) = 0$ to $h_j(x) = \epsilon_j$, the optimal cost changes by approximately $\nu_j^* \epsilon_j$. A large $|\nu_j^*|$ means the constraint is "expensive": relaxing it would significantly improve the objective.
</Remark>

<Example id="ex-lagrange-pca">
**PCA as constrained optimization.** The first principal component maximizes variance subject to unit norm:

$$\max_v v^\top \Sigma v \quad \text{s.t. } \|v\|^2 = 1$$

Lagrangian: $\mathcal{L}(v, \lambda) = v^\top \Sigma v - \lambda(v^\top v - 1)$. Setting $\nabla_v \mathcal{L} = 0$: $2\Sigma v = 2\lambda v$, giving $\Sigma v = \lambda v$. The optimal $v$ is the eigenvector with the largest eigenvalue. The multiplier $\lambda$ equals the maximum variance (the eigenvalue).
</Example>

## KKT Conditions (Inequality Constraints)

<Theorem id="thm-kkt" name="Karush-Kuhn-Tucker (KKT) Conditions">
For the general constrained problem, the **KKT conditions** are necessary for optimality when a **constraint qualification** holds (such as Slater's condition for convex problems, or LICQ, the linear independence of active constraint gradients), and they are also sufficient when the problem is convex. At an optimal point $x^*$ with multipliers $\lambda^* \in \mathbb{R}^m$ (inequality) and $\nu^* \in \mathbb{R}^p$ (equality):

1. **Stationarity:** $\nabla_x f(x^*) + \sum_{i=1}^m \lambda_i^* \nabla g_i(x^*) + \sum_{j=1}^p \nu_j^* \nabla h_j(x^*) = 0$
2. **Primal feasibility:** $g_i(x^*) \leq 0$ for all $i$; $h_j(x^*) = 0$ for all $j$
3. **Dual feasibility:** $\lambda_i^* \geq 0$ for all $i$
4. **Complementary slackness:** $\lambda_i^* g_i(x^*) = 0$ for all $i$
</Theorem>

<Remark id="rmk-complementary-slackness">
**Complementary slackness** is the key structural insight: for each inequality constraint, either:
- The constraint is **active** ($g_i(x^*) = 0$): the constraint is tight and its multiplier $\lambda_i^*$ can be positive, meaning the constraint is "pushing"
- The constraint is **inactive** ($g_i(x^*) < 0$): the constraint is slack and $\lambda_i^* = 0$, so the constraint is irrelevant at the optimum

In SVMs, the data points with active constraints ($y_i(w^\top x_i + b) = 1$) are the **support vectors**: they determine the decision boundary. All other points have $\lambda_i = 0$ and do not affect the solution.
</Remark>

<Remark id="rmk-kkt-sufficient">
**When are KKT conditions sufficient?** For convex problems (convex $f$ and $g_i$, affine $h_j$), the KKT conditions are both necessary and sufficient for global optimality. For non-convex problems, they are only necessary (a KKT point may be a saddle point or local maximum).
</Remark>

## Lagrangian Duality

<Definition id="def-lagrangian-dual" name="Lagrangian Duality">
The **Lagrangian** for the general constrained problem is:

<Equation id="eq-lagrangian-full">

$$\mathcal{L}(x, \lambda, \nu) = f(x) + \sum_{i=1}^m \lambda_i g_i(x) + \sum_{j=1}^p \nu_j h_j(x)$$

</Equation>

The **dual function** is the minimum of the Lagrangian over $x$:

<Equation id="eq-dual-function">

$$d(\lambda, \nu) = \inf_x \mathcal{L}(x, \lambda, \nu)$$

</Equation>

Here $d(\lambda, \nu)$ may equal $-\infty$ for some $(\lambda, \nu)$ when the Lagrangian is unbounded below in $x$; the dual domain is the set where $d$ is finite. The **dual problem** maximizes the dual function: $\max_{\lambda \geq 0, \nu} d(\lambda, \nu)$.
</Definition>

<Theorem id="thm-weak-duality" name="Weak and Strong Duality">
**Weak duality** always holds: $d^* \leq f^*$ (the dual optimal value lower-bounds the primal optimal value). The difference $f^* - d^*$ is the **duality gap**.

**Strong duality** ($d^* = f^*$, zero duality gap) holds when:
- The problem is convex, and
- **Slater's condition** is satisfied: there exists a strictly feasible point $\hat{x}$ with $g_i(\hat{x}) < 0$ for all $i$ (strict inequality)
</Theorem>

<Remark id="rmk-duality-benefits">
**Why duality is useful:**

1. **Easier problem structure:** The dual is always a concave maximization (even when the primal is non-convex), and may have fewer variables or simpler constraints.
2. **Lower bounds:** Weak duality gives certificates of (near-)optimality: if a primal feasible $x$ and dual feasible $(\lambda, \nu)$ satisfy $f(x) - d(\lambda, \nu) \leq \epsilon$, then $x$ is $\epsilon$-optimal.
3. **Kernel trick:** The SVM dual depends on data only through inner products, enabling kernel methods.
4. **Constraint interpretation:** Dual variables $\lambda_i^*$ measure the cost of each constraint, guiding which constraints to relax.
</Remark>

<Example id="ex-svm-dual">
**SVM dual derivation.** The primal SVM problem (with slack variables for the soft-margin case):

$$\min_{w, b, \xi} \frac{1}{2}\|w\|^2 + C\sum_i \xi_i \quad \text{s.t.} \quad y_i(w^\top x_i + b) \geq 1 - \xi_i, \; \xi_i \geq 0$$

The Lagrangian introduces multipliers $\alpha_i \geq 0$ for the margin constraints and $\mu_i \geq 0$ for the $\xi_i \geq 0$ constraints. Setting the stationarity conditions to zero gives:

$$\frac{\partial \mathcal{L}}{\partial w} = 0 \Rightarrow w = \sum_i \alpha_i y_i x_i, \qquad \frac{\partial \mathcal{L}}{\partial b} = 0 \Rightarrow \sum_i \alpha_i y_i = 0, \qquad \frac{\partial \mathcal{L}}{\partial \xi_i} = 0 \Rightarrow \alpha_i + \mu_i = C$$

The last condition with $\mu_i \geq 0$ forces $\alpha_i \leq C$, which combined with $\alpha_i \geq 0$ produces the box constraint $0 \leq \alpha_i \leq C$. Substituting these back yields the dual:

<Equation id="eq-svm-dual">

$$\max_\alpha \sum_{i=1}^N \alpha_i - \frac{1}{2} \sum_{i,j} \alpha_i \alpha_j y_i y_j (x_i^\top x_j) \quad \text{s.t.} \quad 0 \leq \alpha_i \leq C, \; \sum_i \alpha_i y_i = 0$$

</Equation>

The dual depends on data only through inner products $x_i^\top x_j$, enabling the **kernel trick**: replace $x_i^\top x_j$ with $k(x_i, x_j) = \phi(x_i)^\top \phi(x_j)$ for an implicit feature map $\phi$.
</Example>

## Penalty Methods and Augmented Lagrangian

<Remark id="rmk-penalty-methods">
In deep learning, hard constraints are often replaced by **penalty terms** added to the loss:

| Constraint | Penalty Approximation | Used In |
|-----------|----------------------|---------|
| $D_{\text{KL}}(\pi \| \pi_{\text{ref}}) \leq \epsilon$ | $\beta \, D_{\text{KL}}(\pi \| \pi_{\text{ref}})$ | RLHF (the $\beta$ coefficient) |
| $\|W\|_2 \leq c$ | $\lambda \|W\|_2^2$ or projected gradient | Spectral normalization |
| $\|\theta\| \leq c$ | $\frac{\lambda}{2}\|\theta\|^2$ | Weight decay = soft L2 constraint |
| $\sum_i \pi_i = 1, \; \pi_i \geq 0$ | Softmax reparameterization | Mixture models, attention |
| $\text{fairness}(f) \leq \delta$ | $\lambda \cdot \text{fairness}(f)$ | Fair ML |

The penalty coefficient $\lambda$ (or $\beta$) corresponds to the Lagrange multiplier in the equivalent constrained formulation. Tuning $\lambda$ is equivalent to choosing the constraint bound, by strong duality.
</Remark>

## Projected Gradient Descent

<Definition id="def-projected-gd" name="Projected Gradient Descent">
For constrained optimization over a convex set $C$, **projected gradient descent** takes a gradient step and then projects back onto $C$:

<Equation id="eq-projected-gd">

$$x_{t+1} = \Pi_C(x_t - \eta \nabla f(x_t)) \quad \text{where} \quad \Pi_C(z) = \arg\min_{x \in C} \|x - z\|^2$$

</Equation>
</Definition>

<Example id="ex-projections">
**Common projections:**
- **Box constraints** $[a, b]^n$: $\Pi(z) = \text{clip}(z, a, b)$ (elementwise)
- **Simplex** $\Delta^n$: sort $z$ descending, find threshold $\tau$, set $\Pi(z)_i = \max(z_i - \tau, 0)$ [@duchi2008simplex]
- **L2 ball** $\|x\| \leq c$: $\Pi(z) = z \cdot \min(1, c/\|z\|)$ (gradient clipping is a projection)
- **Spectral norm** $\|W\|_2 \leq c$: compute SVD, clip singular values to $\leq c$
</Example>

## ML Applications of Constrained Optimization

<Table id="tab-constrained-ml" caption="Constrained optimization problems in machine learning.">

| Application | Constraint | Solution Approach |
|-------------|-----------|-------------------|
| **SVM** | $y_i(w^\top x_i + b) \geq 1$ | KKT + kernel trick via dual |
| **RLHF** | $D_{\text{KL}}(\pi \| \pi_{\text{ref}}) \leq \epsilon$ | Lagrangian relaxation ($\beta$ penalty) |
| **Constrained generation** | $c(y) \leq \delta$ (e.g., toxicity) | Constrained decoding, penalty |
| **Fair ML** | Demographic parity or equalized odds | Lagrangian dual, penalty |
| **Spectral normalization** | $\|W\|_2 \leq 1$ | Power iteration + projection |
| **Gradient clipping** | $\|g\| \leq c$ | Projection onto L2 ball |
| **Weight clipping** | $\theta \in [a, b]$ | Projection onto box (WGAN) |
| **Simplex weights** | $\pi \geq 0$, $\sum \pi_i = 1$ | Softmax reparameterization |
| **Orthogonal weights** | $W^\top W = I$ | Cayley transform, manifold optimization |

</Table>

## Notation Summary

<Table id="tab-notation-constrained" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $f(x)$ | Objective function |
| $g_i(x) \leq 0$ | Inequality constraints |
| $h_j(x) = 0$ | Equality constraints |
| $\lambda_i \geq 0$ | Dual variable (Lagrange multiplier) for inequality constraint $i$ |
| $\nu_j$ | Dual variable for equality constraint $j$ |
| $\mathcal{L}(x, \lambda, \nu)$ | Lagrangian function |
| $d(\lambda, \nu)$ | Dual function |
| $d^*, f^*$ | Optimal dual and primal values |
| $\Pi_C$ | Projection operator onto convex set $C$ |
| KKT | Karush-Kuhn-Tucker conditions |

</Table>
