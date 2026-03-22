---
sidebar_position: 1
---

# Multivariable Calculus

## Partial Derivatives

For $f: \mathbb{R}^n \to \mathbb{R}$, the **partial derivative** with respect to $x_i$ holds all other variables fixed:

$$
\frac{\partial f}{\partial x_i} = \lim_{h \to 0} \frac{f(x_1, \dots, x_i + h, \dots, x_n) - f(x_1, \dots, x_n)}{h}
$$

The **gradient** collects all partial derivatives into a vector:

$$
\nabla f(x) = \begin{bmatrix} \frac{\partial f}{\partial x_1} \\ \vdots \\ \frac{\partial f}{\partial x_n} \end{bmatrix}
$$

**Key insight:** The gradient points in the direction of steepest ascent. Gradient descent moves in the opposite direction: $x_{t+1} = x_t - \eta \nabla f(x_t)$.

## Directional Derivative

The rate of change of $f$ in the direction of a unit vector $u$ is:

$$
D_u f(x) = \nabla f(x)^\top u = \|\nabla f(x)\| \cos \theta
$$

where $\theta$ is the angle between $\nabla f$ and $u$. This is maximized when $u$ points in the direction of $\nabla f$ and minimized when $u$ points opposite.

## Taylor Expansion

The first-order Taylor expansion of $f$ around $x_0$ is:

$$
f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta
$$

The second-order expansion includes curvature via the Hessian:

$$
f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta + \frac{1}{2} \delta^\top H(x_0) \, \delta
$$

where $H_{ij} = \frac{\partial^2 f}{\partial x_i \partial x_j}$ is the Hessian matrix.

**Key insight:** Gradient descent uses the first-order approximation. Newton's method uses the second-order approximation and sets $\delta^* = -H^{-1} \nabla f$, achieving quadratic convergence near a minimum. The tradeoff is $O(n^3)$ per step vs $O(n)$ for gradient descent.

## Implicit Function Theorem

If $F(x, y) = 0$ defines $y$ implicitly as a function of $x$, and $\frac{\partial F}{\partial y} \neq 0$, then:

$$
\frac{dy}{dx} = -\frac{\partial F / \partial x}{\partial F / \partial y}
$$

**Key insight:** This is used in implicit differentiation through optimization (e.g., differentiating through the solution of an inner optimization problem). It underpins methods like implicit MAML and differentiable optimization layers.

## Loss Landscapes

The loss function $\mathcal{L}(\theta)$ defines a surface in parameter space. Key features:

| Feature | Definition | Gradient condition |
|---------|------------|-------------------|
| Minimum | $\mathcal{L}(\theta^*) \leq \mathcal{L}(\theta)$ locally | $\nabla \mathcal{L} = 0$, $H \succ 0$ |
| Maximum | $\mathcal{L}(\theta^*) \geq \mathcal{L}(\theta)$ locally | $\nabla \mathcal{L} = 0$, $H \prec 0$ |
| Saddle point | Neither min nor max | $\nabla \mathcal{L} = 0$, $H$ indefinite |
| Plateau | $\nabla \mathcal{L} \approx 0$ over a region | Near-zero gradient, near-zero curvature |

In high dimensions ($n \gg 1$), saddle points vastly outnumber local minima. For a random critical point in $n$ dimensions, the probability that all $n$ eigenvalues of $H$ are positive decreases exponentially: $P(\text{min}) \approx 2^{-n}$.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\nabla f$ | Gradient of $f$ |
| $D_u f$ | Directional derivative in direction $u$ |
| $H$ | Hessian matrix (second derivatives) |
| $\delta$ | Perturbation vector |
| $H \succ 0$ | $H$ is positive definite |
| $H \prec 0$ | $H$ is negative definite |
