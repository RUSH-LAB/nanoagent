---
sidebar_position: 2
---

# Convex Optimization

## Convex Sets and Functions

<Definition id="def-convex-set" name="Convex Set">
A set $C$ is **convex** if the line segment between any two points lies in $C$:

$$
\forall x, y \in C, \; \forall \lambda \in [0,1]: \quad \lambda x + (1-\lambda)y \in C
$$
</Definition>

<Definition id="def-convex-function" name="Convex Function">
A function $f$ is **convex** if its epigraph is convex, equivalently:

<Equation id="eq-convexity">

$$f(\lambda x + (1-\lambda)y) \leq \lambda f(x) + (1-\lambda) f(y)$$

</Equation>

For twice-differentiable functions, convexity is equivalent to $H \succeq 0$ (Hessian is positive semi-definite everywhere).
</Definition>

<Remark id="rmk-convex-global-min">
For convex functions, every local minimum is a global minimum. This is why convex optimization has clean convergence guarantees -- gradient descent cannot get stuck in bad local minima.
</Remark>

## Convergence Guarantees

<Theorem id="thm-convex-convergence" name="GD Convergence for Smooth Convex Functions">
For a convex, $L$-smooth function (i.e., $\|\nabla f(x) - \nabla f(y)\| \leq L\|x - y\|$), gradient descent with step size $\eta = 1/L$ converges as:

<Equation id="eq-convex-convergence">

$$f(x_t) - f(x^*) \leq \frac{L \|x_0 - x^*\|^2}{2t}$$

</Equation>

This is an $O(1/t)$ rate. After $t$ steps, the error shrinks by a factor of $t$.
</Theorem>

## Strong Convexity

<Definition id="def-strong-convexity" name="Strong Convexity">
A function is **$\mu$-strongly convex** if:

<Equation id="eq-strong-convexity">

$$f(y) \geq f(x) + \nabla f(x)^\top (y-x) + \frac{\mu}{2} \|y - x\|^2$$

</Equation>
</Definition>

Strong convexity guarantees a unique global minimum and faster convergence:

<Equation id="eq-strong-convex-rate">

$$f(x_t) - f(x^*) \leq \left(1 - \frac{\mu}{L}\right)^t \left(f(x_0) - f(x^*)\right)$$

</Equation>

This is a **linear** (exponential) rate. The **condition number** $\kappa = L / \mu$ controls the speed: smaller $\kappa$ means faster convergence.

<Table id="tab-convex-rates" caption="Convergence rates for different optimization settings.">

| Property | Convergence rate | Example |
|----------|-----------------|---------|
| Convex, smooth | $O(1/t)$ | Logistic regression |
| Strongly convex, smooth | $O(e^{-t/\kappa})$ | Ridge regression |
| Convex, non-smooth | $O(1/\sqrt{t})$ | Lasso (L1 regularization) |

</Table>

## Lipschitz Continuity

<Definition id="def-lipschitz" name="Lipschitz Continuity">
A function $f$ is **$L$-Lipschitz** if:

$$
\|f(x) - f(y)\| \leq L \|x - y\| \quad \forall x, y
$$

A gradient $\nabla f$ is **$L$-Lipschitz** ($L$-smooth) if:

$$
\|\nabla f(x) - \nabla f(y)\| \leq L \|x - y\| \quad \forall x, y
$$
</Definition>

<Remark id="rmk-lipschitz-lr">
The Lipschitz constant $L$ of the gradient bounds the curvature. The maximum safe learning rate is $\eta \leq 1/L$. Using $\eta > 1/L$ causes divergence.
</Remark>

## ML Applications

<Table id="tab-convexity-ml" caption="Convexity of common ML problems.">

| Problem | Convex? | Why it matters |
|---------|---------|----------------|
| Linear regression | Yes (strongly) | Closed-form solution exists |
| Logistic regression | Yes | GD finds global optimum |
| SVM (primal) | Yes | Convex QP, efficient solvers |
| Neural networks | No | No global optimum guarantee |
| Matrix factorization | No | Non-convex but structured |

</Table>

<Remark id="rmk-l2-strong-convexity">
Adding L2 regularization $\frac{\lambda}{2}\|\theta\|^2$ makes any convex loss $\lambda$-strongly convex, guaranteeing exponential convergence with $\kappa = L/\lambda$.
</Remark>

## Notation Summary

<Table id="tab-notation-convex" caption="Notation used in convex optimization.">

| Symbol | Meaning |
|--------|---------|
| $L$ | Lipschitz constant (smoothness) |
| $\mu$ | Strong convexity parameter |
| $\kappa = L/\mu$ | Condition number |
| $H \succeq 0$ | $H$ is positive semi-definite |
| $x^*$ | Global minimum |
| $O(1/t)$ | Sublinear convergence rate |

</Table>
