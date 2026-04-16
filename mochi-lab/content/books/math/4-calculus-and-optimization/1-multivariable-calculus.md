---
sidebar_position: 1
---

# Multivariable Calculus

Multivariable calculus provides the mathematical machinery for optimizing functions of many variables -- the central computational task in machine learning. Every gradient computation, every optimizer step, and every loss landscape analysis uses the tools developed here.

## Partial Derivatives

<Definition id="def-partial-derivative" name="Partial Derivative">
For $f: \mathbb{R}^n \to \mathbb{R}$, the **partial derivative** with respect to $x_i$ measures the rate of change of $f$ while holding all other variables fixed:

<Equation id="eq-partial-derivative">

$$\frac{\partial f}{\partial x_i} = \lim_{h \to 0} \frac{f(x_1, \dots, x_i + h, \dots, x_n) - f(x_1, \dots, x_n)}{h}$$

</Equation>
</Definition>

The **gradient** collects all $n$ partial derivatives into a single vector:

<Equation id="eq-gradient-mv">

$$\nabla f(x) = \begin{bmatrix} \partial f / \partial x_1 \\ \vdots \\ \partial f / \partial x_n \end{bmatrix} \in \mathbb{R}^n$$

</Equation>

<Remark id="rmk-gradient-direction">
The gradient $\nabla f(x)$ points in the direction of steepest ascent of $f$ at $x$. More precisely, for any unit vector $u$, the rate of change $\nabla f^\top u$ is maximized when $u = \nabla f / \|\nabla f\|$. Gradient descent moves in the opposite direction: $x_{t+1} = x_t - \eta \nabla f(x_t)$.
</Remark>

## Directional Derivative

<Definition id="def-directional-derivative" name="Directional Derivative">
The rate of change of $f$ at point $x$ in the direction of a unit vector $u$ is:

<Equation id="eq-directional-derivative">

$$D_u f(x) = \nabla f(x)^\top u = \|\nabla f(x)\| \cos \theta$$

</Equation>

where $\theta$ is the angle between $\nabla f$ and $u$. This is maximized ($= \|\nabla f\|$) when $u$ is parallel to $\nabla f$ and minimized ($= -\|\nabla f\|$) when $u$ is anti-parallel.
</Definition>

<Example id="ex-directional-gradient">
**Why gradient descent is the steepest descent.** We want to find the unit direction $u^*$ that decreases $f$ the most:

$$u^* = \arg\min_{\|u\| = 1} D_u f = \arg\min_{\|u\| = 1} \nabla f^\top u = -\frac{\nabla f}{\|\nabla f\|}$$

The step $x_{t+1} = x_t - \eta \nabla f$ moves in this direction with step size $\eta \|\nabla f\|$. Note that this is only the best direction for infinitesimally small steps -- for finite $\eta$, curvature matters.
</Example>

## Taylor Expansion

<Theorem id="thm-taylor-expansion" name="Multivariate Taylor Expansion">
The Taylor expansion of $f: \mathbb{R}^n \to \mathbb{R}$ around a point $x_0$ is:

**First order** (linear approximation):
$$f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta$$

**Second order** (quadratic approximation):

<Equation id="eq-taylor-expansion">

$$f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta + \frac{1}{2} \delta^\top H(x_0) \, \delta$$

</Equation>

where $H(x_0) = \nabla^2 f(x_0)$ is the Hessian matrix with $H_{ij} = \frac{\partial^2 f}{\partial x_i \partial x_j}$.
</Theorem>

<Remark id="rmk-taylor-optimization">
**First-order vs. second-order methods:**

| Method | Uses | Approximation | Step | Cost per step | Convergence |
|--------|------|---------------|------|---------------|-------------|
| Gradient descent | $\nabla f$ only | Linear | $-\eta \nabla f$ | $O(n)$ | Linear ($O(e^{-t/\kappa})$) |
| Newton's method | $\nabla f$ and $H$ | Quadratic | $-H^{-1} \nabla f$ | $O(n^3)$ | Quadratic (near optimum) |
| L-BFGS | $\nabla f$ + approximate $H^{-1}$ | Quasi-quadratic | $-\tilde{H}^{-1} \nabla f$ | $O(mn)$, $m \ll n$ | Superlinear |

Newton's method finds the exact minimum of the quadratic approximation in one step. It converges quadratically near a minimum ($\|x_{t+1} - x^*\| \leq c\|x_t - x^*\|^2$) but is impractical for neural networks ($n > 10^6$) because forming and inverting the Hessian costs $O(n^2)$ memory and $O(n^3)$ computation.
</Remark>

## Implicit Function Theorem and Implicit Differentiation

<Theorem id="thm-implicit-function" name="Implicit Function Theorem">
Let $F: \mathbb{R}^n \times \mathbb{R}^m \to \mathbb{R}^m$ be continuously differentiable, and suppose $F(x_0, y_0) = 0$ and $\frac{\partial F}{\partial y}(x_0, y_0)$ is invertible. Then there exists a neighborhood of $x_0$ and a unique differentiable function $y(x)$ such that $F(x, y(x)) = 0$, with:

<Equation id="eq-implicit-function">

$$\frac{\partial y}{\partial x} = -\left(\frac{\partial F}{\partial y}\right)^{-1} \frac{\partial F}{\partial x}$$

</Equation>
</Theorem>

<Remark id="rmk-implicit-diff-ml">
**Implicit differentiation in ML.** This theorem underpins several important techniques:

1. **Differentiating through optimization:** If $y^*(x) = \arg\min_y g(x, y)$, the optimality condition is $\nabla_y g(x, y^*) = 0$. The implicit function theorem gives $\partial y^* / \partial x$ without unrolling the optimization.
2. **Implicit MAML** [@finn2017maml]: Differentiates through the inner loop of meta-learning without storing the optimization trajectory.
3. **Differentiable optimization layers** [@amos2017optnet]: Backpropagation through convex optimization problems embedded as neural network layers.
4. **Equilibrium models** (DEQ) [@bai2019deep]: Differentiates through the fixed point $z^* = f(z^*; \theta)$ without storing the forward iterations.
</Remark>

## Total Derivative and Chain Rule

<Definition id="def-total-derivative" name="Total Derivative">
If $f$ depends on $t$ both directly and through $x(t)$, the **total derivative** is:

<Equation id="eq-total-derivative">

$$\frac{df}{dt} = \frac{\partial f}{\partial t} + \sum_{i=1}^n \frac{\partial f}{\partial x_i} \frac{dx_i}{dt} = \frac{\partial f}{\partial t} + \nabla_x f^\top \frac{dx}{dt}$$

</Equation>
</Definition>

<Remark id="rmk-total-derivative-ml">
The total derivative appears in:
- **Learning rate schedules:** The loss changes due to both parameter updates and the changing learning rate
- **Curriculum learning:** The data distribution changes over time, so the expected loss has both explicit and implicit dependence on time
- **Neural ODEs** [@chen2018neural]: Model the hidden state as a continuous function $h(t)$ governed by $dh/dt = f(h(t), t; \theta)$, where the total derivative controls dynamics
</Remark>

## Loss Landscapes

The loss function $\mathcal{L}(\theta)$ defines a surface in the $P$-dimensional parameter space ($P$ = number of parameters). Understanding this surface guides algorithm design.

<Table id="tab-critical-points" caption="Types of critical points in loss landscapes.">

| Feature | Definition | Hessian Condition | Frequency in High-$d$ |
|---------|------------|-------------------|----------------------|
| **Local minimum** | $\mathcal{L}(\theta^*) \leq \mathcal{L}(\theta)$ in a neighborhood | $H \succ 0$ (all eigenvalues $> 0$) | Rare: $\sim 2^{-P}$ of critical points |
| **Local maximum** | $\mathcal{L}(\theta^*) \geq \mathcal{L}(\theta)$ in a neighborhood | $H \prec 0$ (all eigenvalues $< 0$) | Rare |
| **Saddle point** | Neither min nor max | $H$ indefinite (mixed eigenvalues) | Overwhelmingly common |
| **Plateau** | $\nabla \mathcal{L} \approx 0$ over a region | Near-zero gradient and curvature | Common in deep networks |
| **Valley** | Narrow region with low loss | High curvature in most directions | Where SGD typically converges |

</Table>

<Remark id="rmk-high-dim-landscape">
In high dimensions ($P \gg 1$), the character of the loss landscape changes qualitatively:

1. **Saddle points dominate.** For a random critical point, each Hessian eigenvalue is independently positive or negative with roughly equal probability. The probability that all $P$ eigenvalues are positive (a minimum) is $\sim 2^{-P}$, which is astronomically small for $P = 10^9$.
2. **Local minima are near-global.** Empirically, the loss values at different local minima of overparameterized networks are clustered near the global minimum -- there are no "bad" local minima that trap optimization [@choromanska2015loss].
3. **Mode connectivity.** Good local minima found by different training runs are connected by low-loss paths through parameter space [@draxler2018essentially]. This suggests the loss landscape has a connected valley structure rather than isolated basins.
</Remark>

## Integration in ML

<Remark id="rmk-integration-ml">
While optimization (differentiation) dominates ML computationally, integration appears in several important places:

| Application | Integral | Approximation |
|-------------|----------|---------------|
| **Bayesian inference** | $p(\theta|\mathcal{D}) = p(\mathcal{D}|\theta)p(\theta)/\int p(\mathcal{D}|\theta')p(\theta')d\theta'$ | MCMC, variational inference |
| **Expected loss** | $\mathbb{E}_{x,y}[\ell(f_\theta(x), y)]$ | Monte Carlo (mini-batch) |
| **Marginal likelihood** | $p(\mathcal{D}) = \int p(\mathcal{D}|\theta)p(\theta)d\theta$ | Laplace approximation, BIC |
| **Normalizing flows** | Change of variables: $p(z) = p(x)|\det \partial f / \partial x|^{-1}$ | Tractable by design |
| **Diffusion models** | $\int_0^T f(x_t, t)dt$ (SDE/ODE) | Numerical integrators (Euler, Heun) |
</Remark>

## Notation Summary

<Table id="tab-notation-mvcalc" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\nabla f$ | Gradient of $f$ (column vector) |
| $D_u f$ | Directional derivative in direction $u$ |
| $H = \nabla^2 f$ | Hessian matrix |
| $\delta$ | Perturbation vector |
| $H \succ 0$ | $H$ is positive definite |
| $H \prec 0$ | $H$ is negative definite |
| $H \succeq 0$ | $H$ is positive semi-definite |
| $df/dt$ | Total derivative |
| $\partial f/\partial x_i$ | Partial derivative |

</Table>
