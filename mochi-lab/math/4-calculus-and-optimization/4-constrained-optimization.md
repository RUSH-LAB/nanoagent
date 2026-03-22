---
sidebar_position: 4
---

# Constrained Optimization

## The Constrained Problem

Many ML problems require optimization subject to constraints:

$$
\min_x f(x) \quad \text{subject to} \quad g_i(x) \leq 0, \; i = 1, \dots, m \quad \text{and} \quad h_j(x) = 0, \; j = 1, \dots, p
$$

## Lagrange Multipliers (Equality Constraints)

For $\min_x f(x)$ subject to $h(x) = 0$, introduce a **Lagrange multiplier** $\nu$ and solve:

$$
\mathcal{L}(x, \nu) = f(x) + \nu^\top h(x)
$$

At the optimum, $\nabla_x \mathcal{L} = 0$ and $h(x) = 0$. Geometrically, the gradient of $f$ must be parallel to the gradient of $h$ at the optimal point:

$$
\nabla f(x^*) = -\nu \nabla h(x^*)
$$

**Key insight:** The multiplier $\nu$ measures the sensitivity of the optimal value to the constraint. If $h(x) = 0$ is relaxed to $h(x) = \epsilon$, the optimal cost changes by approximately $\nu \epsilon$.

## KKT Conditions (Inequality Constraints)

The **Karush-Kuhn-Tucker conditions** generalize Lagrange multipliers. At an optimal point $x^*$ with multipliers $\lambda^*$ (inequality) and $\nu^*$ (equality):

1. **Stationarity:** $\nabla_x f(x^*) + \sum_i \lambda_i^* \nabla g_i(x^*) + \sum_j \nu_j^* \nabla h_j(x^*) = 0$
2. **Primal feasibility:** $g_i(x^*) \leq 0$, $h_j(x^*) = 0$
3. **Dual feasibility:** $\lambda_i^* \geq 0$
4. **Complementary slackness:** $\lambda_i^* g_i(x^*) = 0$

Complementary slackness means: either a constraint is active ($g_i = 0$) or its multiplier is zero ($\lambda_i = 0$). A constraint does not "push" unless it is tight.

**Key insight:** KKT conditions are necessary for optimality (and sufficient when the problem is convex). They transform a constrained optimization into a system of equations.

## Lagrangian Duality

The **Lagrangian** is:

$$
\mathcal{L}(x, \lambda, \nu) = f(x) + \sum_i \lambda_i g_i(x) + \sum_j \nu_j h_j(x)
$$

The **dual function** is the infimum over $x$:

$$
d(\lambda, \nu) = \inf_x \mathcal{L}(x, \lambda, \nu) \leq f(x^*)
$$

The **dual problem** maximizes the dual function: $\max_{\lambda \geq 0, \nu} d(\lambda, \nu)$. Weak duality holds always: $d^* \leq f^*$. **Strong duality** ($d^* = f^*$) holds when the problem is convex and Slater's condition is satisfied (a strictly feasible point exists).

## ML Applications

| Application | Constrained formulation | Key idea |
|-------------|------------------------|----------|
| **SVM** | $\min \frac{1}{2}\|w\|^2$ s.t. $y_i(w^\top x_i + b) \geq 1$ | Margin maximization via KKT |
| **RLHF** | $\max_\pi \mathbb{E}[r(x,y)]$ s.t. $D_{KL}(\pi \| \pi_{\text{ref}}) \leq \epsilon$ | KL constraint via Lagrange multiplier $\beta$ |
| **Constrained generation** | $\max_y p(y|x)$ s.t. $c(y) \leq \delta$ | Constrained decoding |
| **Fair ML** | $\min \mathcal{L}(\theta)$ s.t. demographic parity | Fairness constraints via dual |
| **Norm constraints** | $\min \mathcal{L}(\theta)$ s.t. $\|W\|_2 \leq c$ | Spectral normalization |

**SVM dual derivation:** The primal SVM problem with inequality constraints $y_i(w^\top x_i + b) \geq 1$ yields the dual:

$$
\max_\alpha \sum_i \alpha_i - \frac{1}{2} \sum_{i,j} \alpha_i \alpha_j y_i y_j (x_i^\top x_j) \quad \text{s.t.} \quad \alpha_i \geq 0, \; \sum_i \alpha_i y_i = 0
$$

The dual depends on data only through dot products $x_i^\top x_j$, enabling the **kernel trick**: replace $x_i^\top x_j$ with $k(x_i, x_j)$ to work in infinite-dimensional feature spaces.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $f(x)$ | Objective function |
| $g_i(x) \leq 0$ | Inequality constraints |
| $h_j(x) = 0$ | Equality constraints |
| $\lambda_i$ | Dual variable for inequality constraint $i$ |
| $\nu_j$ | Dual variable for equality constraint $j$ |
| $\mathcal{L}$ | Lagrangian |
| $d(\lambda, \nu)$ | Dual function |
| $d^*, f^*$ | Optimal dual and primal values |
| KKT | Karush-Kuhn-Tucker conditions |
