---
sidebar_position: 1
---

# Multivariable Calculus

## Partial Derivatives

<Definition id="def-partial-derivative" name="Partial Derivative">
For $f: \mathbb{R}^n \to \mathbb{R}$, the **partial derivative** with respect to $x_i$ holds all other variables fixed:

<Equation id="eq-partial-derivative">

$$\frac{\partial f}{\partial x_i} = \lim_{h \to 0} \frac{f(x_1, \dots, x_i + h, \dots, x_n) - f(x_1, \dots, x_n)}{h}$$

</Equation>
</Definition>

The **gradient** collects all partial derivatives into a vector:

<Equation id="eq-gradient-mv">

$$\nabla f(x) = \begin{bmatrix} \frac{\partial f}{\partial x_1} \\ \vdots \\ \frac{\partial f}{\partial x_n} \end{bmatrix}$$

</Equation>

<Remark id="rmk-gradient-direction">
The gradient points in the direction of steepest ascent. Gradient descent moves in the opposite direction: $x_{t+1} = x_t - \eta \nabla f(x_t)$.
</Remark>

## Directional Derivative

<Definition id="def-directional-derivative" name="Directional Derivative">
The rate of change of $f$ in the direction of a unit vector $u$ is:

<Equation id="eq-directional-derivative">

$$D_u f(x) = \nabla f(x)^\top u = \|\nabla f(x)\| \cos \theta$$

</Equation>

where $\theta$ is the angle between $\nabla f$ and $u$. This is maximized when $u$ points in the direction of $\nabla f$ and minimized when $u$ points opposite.
</Definition>

## Taylor Expansion

The first-order Taylor expansion of $f$ around $x_0$ is:

$$
f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta
$$

The second-order expansion includes curvature via the Hessian:

<Equation id="eq-taylor-expansion">

$$f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta + \frac{1}{2} \delta^\top H(x_0) \, \delta$$

</Equation>

where $H_{ij} = \frac{\partial^2 f}{\partial x_i \partial x_j}$ is the Hessian matrix.

<Remark id="rmk-newton-vs-gd">
Gradient descent uses the first-order approximation. Newton's method uses the second-order approximation and sets $\delta^* = -H^{-1} \nabla f$, achieving quadratic convergence near a minimum. The tradeoff is $O(n^3)$ per step vs $O(n)$ for gradient descent.
</Remark>

## Implicit Function Theorem

<Theorem id="thm-implicit-function" name="Implicit Function Theorem">
If $F(x, y) = 0$ defines $y$ implicitly as a function of $x$, and $\frac{\partial F}{\partial y} \neq 0$, then:

<Equation id="eq-implicit-function">

$$\frac{dy}{dx} = -\frac{\partial F / \partial x}{\partial F / \partial y}$$

</Equation>
</Theorem>

<Remark id="rmk-implicit-diff-ml">
This is used in implicit differentiation through optimization (e.g., differentiating through the solution of an inner optimization problem). It underpins methods like implicit MAML [@finn2017maml] and differentiable optimization layers.
</Remark>

## Loss Landscapes

The loss function $\mathcal{L}(\theta)$ defines a surface in parameter space. Key features:

<Table id="tab-critical-points" caption="Types of critical points in loss landscapes.">

| Feature | Definition | Gradient condition |
|---------|------------|-------------------|
| Minimum | $\mathcal{L}(\theta^*) \leq \mathcal{L}(\theta)$ locally | $\nabla \mathcal{L} = 0$, $H \succ 0$ |
| Maximum | $\mathcal{L}(\theta^*) \geq \mathcal{L}(\theta)$ locally | $\nabla \mathcal{L} = 0$, $H \prec 0$ |
| Saddle point | Neither min nor max | $\nabla \mathcal{L} = 0$, $H$ indefinite |
| Plateau | $\nabla \mathcal{L} \approx 0$ over a region | Near-zero gradient, near-zero curvature |

</Table>

In high dimensions ($n \gg 1$), saddle points vastly outnumber local minima. For a random critical point in $n$ dimensions, the probability that all $n$ eigenvalues of $H$ are positive decreases exponentially: $P(\text{min}) \approx 2^{-n}$.

## Notation Summary

<Table id="tab-notation-mvcalc" caption="Notation used in multivariable calculus.">

| Symbol | Meaning |
|--------|---------|
| $\nabla f$ | Gradient of $f$ |
| $D_u f$ | Directional derivative in direction $u$ |
| $H$ | Hessian matrix (second derivatives) |
| $\delta$ | Perturbation vector |
| $H \succ 0$ | $H$ is positive definite |
| $H \prec 0$ | $H$ is negative definite |

</Table>
