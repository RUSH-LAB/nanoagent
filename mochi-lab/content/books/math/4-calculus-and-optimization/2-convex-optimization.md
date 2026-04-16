---
sidebar_position: 2
---

# Convex Optimization

Convex optimization is the "easy case" of optimization: convex problems have a rich theory with clean convergence guarantees, efficient algorithms, and no bad local minima. Many ML problems are convex (linear regression, logistic regression, SVMs), and understanding convexity illuminates why non-convex deep learning is harder and what structure makes it tractable.

## Convex Sets

<Definition id="def-convex-set" name="Convex Set">
A set $C \subseteq \mathbb{R}^n$ is **convex** if the line segment between any two points in $C$ lies entirely within $C$:

$$\forall x, y \in C, \; \forall \lambda \in [0,1]: \quad \lambda x + (1-\lambda)y \in C$$
</Definition>

<Example id="ex-convex-sets">
**Examples of convex sets:**
- Hyperplanes: $\{x : a^\top x = b\}$
- Half-spaces: $\{x : a^\top x \leq b\}$
- Balls: $\{x : \|x - c\| \leq r\}$ (in any norm)
- Polyhedra: $\{x : Ax \leq b\}$ (intersection of half-spaces)
- Positive semidefinite cone: $\{X \in \mathbb{S}^n : X \succeq 0\}$

Intersections of convex sets are convex. This means constraints like $Ax \leq b$ and $\|x\| \leq c$ together define a convex feasible region.
</Example>

## Convex Functions

<Definition id="def-convex-function" name="Convex Function">
A function $f: \mathbb{R}^n \to \mathbb{R}$ is **convex** if for all $x, y$ in its domain and $\lambda \in [0,1]$:

<Equation id="eq-convexity">

$$f(\lambda x + (1-\lambda)y) \leq \lambda f(x) + (1-\lambda) f(y)$$

</Equation>

Geometrically, the chord between any two points on the graph of $f$ lies above (or on) the graph.

**Equivalent characterizations** (for twice-differentiable $f$):

1. **First-order condition:** $f(y) \geq f(x) + \nabla f(x)^\top(y - x)$ for all $x, y$ (the tangent hyperplane is a global underestimator)
2. **Second-order condition:** $\nabla^2 f(x) \succeq 0$ for all $x$ (the Hessian is PSD everywhere)
</Definition>

<Theorem id="thm-convex-global" name="Local Implies Global for Convex Functions">
For a convex function, **every local minimum is a global minimum**. Moreover, the set of global minima is convex (it may be a single point, a line, or a higher-dimensional flat).
</Theorem>

**Proof.** Suppose $x^*$ is a local minimum but not global: there exists $y$ with $f(y) < f(x^*)$. By convexity, for any $\lambda \in (0,1)$: $f(\lambda y + (1-\lambda)x^*) \leq \lambda f(y) + (1-\lambda)f(x^*) < f(x^*)$. But $\lambda y + (1-\lambda)x^*$ can be made arbitrarily close to $x^*$ by taking $\lambda \to 0$, contradicting local optimality. $\square$

<Remark id="rmk-convex-global-min">
This theorem is why convex optimization has clean convergence guarantees: gradient descent cannot get stuck in bad local minima. For non-convex problems (neural networks), this guarantee fails -- but empirically, the local minima found by SGD on overparameterized networks have loss values very close to the global minimum.
</Remark>

<Table id="tab-convex-functions" caption="Common convex and non-convex functions in ML.">

| Function | Convex? | Strongly Convex? | Notes |
|----------|---------|-------------------|-------|
| $\|x\|_p$ for $p \geq 1$ | Yes | No | Any norm is convex |
| $\|Ax - b\|_2^2$ | Yes | Yes (if $A$ full rank, $\mu = \sigma_{\min}(A)^2$) | Linear regression |
| $\log(1 + e^{-yz})$ | Yes (in model params) | No | Logistic regression loss |
| $\max(0, 1 - yz)$ | Yes | No | Hinge loss (SVM) |
| $-\sum p_i \log q_i$ | Yes in $q$ | No | Cross entropy |
| ReLU network loss | No | No | Non-convex in weights |
| $e^x$ | Yes | No | Exponential |
| $x \log x$ for $x > 0$ | Yes | No | Entropy (negated) |

</Table>

## Lipschitz Smoothness

<Definition id="def-lipschitz" name="$L$-Smoothness (Lipschitz Gradient)">
A differentiable function $f$ has **$L$-Lipschitz continuous gradient** (is **$L$-smooth**) if:

<Equation id="eq-lipschitz-gradient">

$$\|\nabla f(x) - \nabla f(y)\| \leq L \|x - y\| \quad \forall x, y$$

</Equation>

Equivalently, $f$ is upper-bounded by a quadratic around any point:

$$f(y) \leq f(x) + \nabla f(x)^\top(y-x) + \frac{L}{2}\|y-x\|^2$$

The constant $L$ is the largest eigenvalue of the Hessian: $L = \sup_x \lambda_{\max}(\nabla^2 f(x))$.
</Definition>

<Remark id="rmk-lipschitz-lr">
**Connection to learning rate.** $L$-smoothness guarantees that gradient descent with step size $\eta \leq 1/L$ makes monotonic progress: each step decreases the loss by at least $\frac{\eta}{2}\|\nabla f\|^2$. Using $\eta > 1/L$ can cause the loss to increase or diverge. This is the theoretical justification for the common practice of reducing the learning rate when training becomes unstable.
</Remark>

## Strong Convexity

<Definition id="def-strong-convexity" name="$\mu$-Strong Convexity">
A function is **$\mu$-strongly convex** ($\mu > 0$) if the Hessian is bounded below by $\mu I$:

$$\nabla^2 f(x) \succeq \mu I \quad \forall x$$

Equivalently:

<Equation id="eq-strong-convexity">

$$f(y) \geq f(x) + \nabla f(x)^\top (y-x) + \frac{\mu}{2} \|y - x\|^2$$

</Equation>

Strong convexity guarantees a unique global minimum and a lower bound on curvature.
</Definition>

<Remark id="rmk-l2-strong-convexity">
**L2 regularization creates strong convexity.** Adding $\frac{\lambda}{2}\|\theta\|^2$ to any convex loss makes it $\lambda$-strongly convex (since $\nabla^2(\frac{\lambda}{2}\|\theta\|^2) = \lambda I$). This guarantees:
- A unique global minimum
- Exponential convergence with condition number $\kappa = (L + \lambda)/\lambda$
- Better numerical conditioning

This is one of the key benefits of weight decay beyond regularization: it improves optimization by making the problem better conditioned.
</Remark>

## Convergence Guarantees

<Theorem id="thm-convex-convergence" name="GD Convergence for Smooth Convex Functions">
For a convex, $L$-smooth function, gradient descent with step size $\eta = 1/L$ satisfies:

<Equation id="eq-convex-convergence">

$$f(x_t) - f(x^*) \leq \frac{L \|x_0 - x^*\|^2}{2t}$$

</Equation>
</Theorem>

<Theorem id="thm-strongly-convex-convergence" name="GD Convergence for Strongly Convex Functions">
For a $\mu$-strongly convex, $L$-smooth function, gradient descent with $\eta = 1/L$ converges exponentially:

<Equation id="eq-strong-convex-rate">

$$f(x_t) - f(x^*) \leq \left(1 - \frac{\mu}{L}\right)^t \left(f(x_0) - f(x^*)\right) = \left(1 - \frac{1}{\kappa}\right)^t \left(f(x_0) - f(x^*)\right)$$

</Equation>

where $\kappa = L/\mu$ is the **condition number**.
</Theorem>

<Table id="tab-convex-rates" caption="Convergence rates for different optimization settings.">

| Setting | Rate (GD) | Rate (Accelerated) | Example |
|---------|-----------|--------------------| --------|
| Convex, $L$-smooth | $O(L/t)$ | $O(L/t^2)$ | Logistic regression |
| $\mu$-strongly convex, $L$-smooth | $O((1-1/\kappa)^t)$ | $O((1-1/\sqrt{\kappa})^t)$ | Ridge regression |
| Convex, non-smooth | $O(1/\sqrt{t})$ | $O(1/\sqrt{t})$ | Lasso, SVM |

</Table>

<Remark id="rmk-acceleration">
**Nesterov acceleration.** For smooth convex problems, Nesterov's accelerated gradient method achieves the rate $O(L/t^2)$ -- a quadratic improvement over gradient descent's $O(L/t)$ -- by evaluating the gradient at a "lookahead" point. For strongly convex problems, the improvement is from $O((1-1/\kappa)^t)$ to $O((1-1/\sqrt{\kappa})^t)$. These rates are provably optimal: no first-order method can converge faster [@nesterov1983method].
</Remark>

## Proximal Methods

<Definition id="def-proximal-operator" name="Proximal Operator">
For a convex function $g$ (possibly non-smooth), the **proximal operator** is:

<Equation id="eq-proximal">

$$\text{prox}_{\eta g}(x) = \arg\min_z \left\{ g(z) + \frac{1}{2\eta}\|z - x\|^2 \right\}$$

</Equation>

The proximal operator generalizes the gradient step to non-smooth functions. For smooth $g$, it reduces to the gradient step: $\text{prox}_{\eta g}(x) = x - \eta \nabla g(x) + O(\eta^2)$.
</Definition>

<Example id="ex-proximal-l1">
**Proximal operator for L1.** For $g(\theta) = \lambda\|\theta\|_1$, the proximal operator is the **soft-thresholding** operator:

$$\text{prox}_{\eta \lambda \|\cdot\|_1}(\theta)_i = \text{sign}(\theta_i) \max(|\theta_i| - \eta\lambda, 0)$$

This is the basis of ISTA (Iterative Shrinkage-Thresholding Algorithm) for sparse optimization.
</Example>

## Duality

<Definition id="def-conjugate" name="Convex Conjugate (Fenchel Conjugate)">
The **convex conjugate** of $f$ is:

<Equation id="eq-conjugate">

$$f^*(y) = \sup_x \left\{ y^\top x - f(x) \right\}$$

</Equation>

Key properties: $f^{**} = f$ for convex $f$ (biconjugate is the original function), $(f + g)^* = f^* \star g^*$ (infimal convolution), and $\nabla f^* = (\nabla f)^{-1}$ (gradients are inverses).
</Definition>

<Remark id="rmk-conjugate-ml">
Convex conjugates appear in ML in several places:
- **Variational representation of KL divergence:** $D_{\text{KL}}(p \| q) = \sup_T \{\mathbb{E}_p[T] - \log \mathbb{E}_q[e^T]\}$ (Donsker--Varadhan)
- **f-GAN losses:** Use the conjugate of $f$-divergences to derive trainable discriminator objectives
- **Legendre transform:** Converts between natural and expectation parameterizations of exponential families
</Remark>

## ML Applications of Convex Optimization

<Table id="tab-convexity-ml" caption="Convexity status of common ML problems.">

| Problem | Convex? | Strongly Convex? | Solver |
|---------|---------|-------------------|--------|
| Linear regression | Yes | Yes (if $\text{rank}(X) = n$) | Closed-form or CG |
| Ridge regression | Yes | Yes ($\mu = \lambda$) | Closed-form |
| Logistic regression | Yes | No (only with L2 reg) | L-BFGS, Newton-CG |
| SVM (hard margin) | Yes | Yes | QP solver |
| SVM (soft margin) | Yes | Yes | SMO, LibSVM |
| Lasso | Yes | No | ISTA/FISTA, coordinate descent |
| Matrix factorization | No | No | Alternating minimization |
| Neural networks | No | No | SGD, Adam |
| Transformer training | No | No | AdamW + warmup + cosine |

</Table>

## Notation Summary

<Table id="tab-notation-convex" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $L$ | Lipschitz constant of the gradient ($L$-smoothness) |
| $\mu$ | Strong convexity parameter |
| $\kappa = L/\mu$ | Condition number |
| $H \succeq 0$ | $H$ is positive semi-definite |
| $x^*$ | Global minimizer |
| $f^*$ | Optimal value: $f(x^*)$ |
| $\text{prox}_g$ | Proximal operator of $g$ |
| $f^*(\cdot)$ | Convex conjugate of $f$ |
| $O(1/t)$ | Sublinear convergence rate |
| $O((1-c)^t)$ | Linear (exponential) convergence rate |

</Table>
