---
sidebar_position: 5
---

# Matrix Calculus

Matrix calculus is the language of neural network gradient derivations. Every backpropagation formula, every optimizer update, and every gradient identity used in ML is an application of the rules developed here.

## Gradient of a Scalar Function

<Definition id="def-gradient" name="Gradient">
For a scalar-valued function $f: \mathbb{R}^n \to \mathbb{R}$, the **gradient** is the column vector of partial derivatives:

<Equation id="eq-gradient">

$$\nabla_x f = \begin{bmatrix} \partial f / \partial x_1 \\ \vdots \\ \partial f / \partial x_n \end{bmatrix} \in \mathbb{R}^n$$

</Equation>

The gradient points in the direction of steepest ascent of $f$. Its magnitude $\|\nabla f\|$ equals the maximum directional derivative: the rate of change in the steepest direction.
</Definition>

<Remark id="rmk-gradient-convention">
**Layout convention.** There are two conventions for matrix calculus: the **numerator layout** (gradient is a column vector, Jacobian has shape $m \times n$) and the **denominator layout** (gradient is a row vector, Jacobian has shape $n \times m$). We follow the **numerator layout** (also called the "Jacobian formulation"), which is standard in ML and consistent with PyTorch's `.grad` attribute.
</Remark>

## Common Gradient Identities

These identities are the building blocks of every gradient derivation in ML. Let $a, x \in \mathbb{R}^n$, $A \in \mathbb{R}^{n \times n}$ (or appropriate dimensions):

<Table id="tab-gradient-identities" caption="Essential gradient identities for ML. All gradients are column vectors (numerator layout).">

| Function $f(x)$ | Gradient $\nabla_x f$ | Proof Sketch |
|------------------|----------------------|-------------|
| $a^\top x$ | $a$ | $\frac{\partial}{\partial x_i} \sum_j a_j x_j = a_i$ |
| $x^\top x = \|x\|_2^2$ | $2x$ | Special case of next row with $A = I$ |
| $x^\top A x$ | $(A + A^\top) x$ | $\frac{\partial}{\partial x_i} \sum_{jk} x_j A_{jk} x_k = \sum_k A_{ik}x_k + \sum_j A_{ji}x_j$ |
| $x^\top A x$ (A symmetric) | $2Ax$ | Since $A + A^\top = 2A$ |
| $\|Ax - b\|_2^2$ | $2A^\top(Ax - b)$ | Chain rule on $(Ax-b)^\top(Ax-b)$ |
| $\|x\|_1 = \sum_i |x_i|$ | $\text{sign}(x)$ | Subgradient; non-smooth at $x_i = 0$ |
| $\sigma(w^\top x)$ | $\sigma(w^\top x)(1 - \sigma(w^\top x)) \cdot w$ | Chain rule with $\sigma' = \sigma(1-\sigma)$ |
| $\log(1 + e^{w^\top x})$ (softplus) | $\sigma(w^\top x) \cdot w$ | $\text{softplus}' = \sigma$ |

</Table>

<Example id="ex-normal-equation-derivation">
**Deriving the normal equation.** For linear regression, minimize $\mathcal{L}(\theta) = \|X\theta - y\|^2 = (X\theta - y)^\top(X\theta - y)$:

$$\nabla_\theta \mathcal{L} = 2X^\top(X\theta - y) = 0$$

$$X^\top X \theta = X^\top y$$

$$\theta^* = (X^\top X)^{-1} X^\top y \quad \text{(assuming } X^\top X \text{ is invertible)}$$

This is the **normal equation**. The solution $\hat{y} = X\theta^*$ is the orthogonal projection of $y$ onto $\text{col}(X)$.
</Example>

## Jacobian

<Definition id="def-jacobian-matcalc" name="Jacobian">
For a vector-valued function $f: \mathbb{R}^n \to \mathbb{R}^m$, the **Jacobian** is the $m \times n$ matrix of all first partial derivatives:

<Equation id="eq-jacobian-matcalc">

$$J = \frac{\partial f}{\partial x} \in \mathbb{R}^{m \times n}, \qquad J_{ij} = \frac{\partial f_i}{\partial x_j}$$

</Equation>

The Jacobian is the best **linear approximation** to $f$ near $x$:

$$f(x + \delta) \approx f(x) + J \delta + O(\|\delta\|^2)$$

</Definition>

<Table id="tab-jacobian-examples" caption="Jacobians of common operations in neural networks.">

| Operation $f(x)$ | Jacobian $\partial f / \partial x$ | Shape |
|-------------------|----------------------------------|-------|
| $Ax$ (linear) | $A$ | $m \times n$ |
| $\text{ReLU}(x)$ (elementwise) | $\text{diag}(\mathbf{1}[x > 0])$ | $n \times n$ (diagonal) |
| $\text{softmax}(x)$ | $\text{diag}(s) - ss^\top$ where $s = \text{softmax}(x)$ | $n \times n$ |
| $x \odot y$ (Hadamard) | $\text{diag}(y)$ (w.r.t. $x$) | $n \times n$ (diagonal) |
| $\|x\|_2$ | $x^\top / \|x\|_2$ | $1 \times n$ |
| Layer norm | Complex; see dedicated derivation | $n \times n$ |

</Table>

<Remark id="rmk-softmax-jacobian">
**The softmax Jacobian** $J_{ij} = s_i(\delta_{ij} - s_j)$ is dense and $n \times n$. For a vocabulary of $V = 100{,}000$ tokens, materializing it would require $V^2 = 10^{10}$ entries. This is why backpropagation uses VJPs (vector-Jacobian products $v^\top J$) rather than full Jacobians -- the VJP through softmax costs $O(V)$, not $O(V^2)$.
</Remark>

## Hessian

<Definition id="def-hessian" name="Hessian">
For $f: \mathbb{R}^n \to \mathbb{R}$, the **Hessian** is the $n \times n$ matrix of second partial derivatives:

<Equation id="eq-hessian">

$$H = \nabla^2 f, \qquad H_{ij} = \frac{\partial^2 f}{\partial x_i \partial x_j}$$

</Equation>

The Hessian is symmetric (by Schwarz's theorem, assuming continuous second derivatives) and encodes the local **curvature** of $f$.
</Definition>

The second-order Taylor expansion around a point $x_0$:

<Equation id="eq-taylor-second-order">

$$f(x_0 + \delta) \approx f(x_0) + \nabla f(x_0)^\top \delta + \frac{1}{2} \delta^\top H(x_0) \, \delta$$

</Equation>

<Table id="tab-hessian-applications" caption="Applications of the Hessian in ML.">

| Application | How the Hessian Is Used |
|-------------|------------------------|
| **Newton's method** | Step: $\delta = -H^{-1} \nabla f$. Quadratic convergence but $O(n^3)$ per step |
| **Critical point classification** | PD $\to$ minimum, ND $\to$ maximum, indefinite $\to$ saddle |
| **Curvature analysis** | Eigenvalues of $H$ reveal loss landscape geometry |
| **Natural gradient** | Uses Fisher information (expected Hessian of log-likelihood) |
| **Hessian-free optimization** | Uses $Hv$ products (no explicit $H$) for conjugate gradient |
| **Influence functions** | $H^{-1}$ weights the effect of removing a training point |
| **Pruning (OBS/OBD)** | Uses $H^{-1}$ to estimate the cost of removing a weight |
| **Laplace approximation** | Approximates posterior $p(\theta|\mathcal{D}) \approx \mathcal{N}(\theta_{\text{MAP}}, H^{-1})$ |

</Table>

<Remark id="rmk-newton-method">
**Newton's method** sets the Taylor approximation's gradient to zero: $\nabla f + H\delta = 0 \implies \delta^* = -H^{-1} \nabla f$. This converges quadratically near a minimum ($\|x_{t+1} - x^*\| \leq c\|x_t - x^*\|^2$) but costs $O(n^2)$ memory (for storing $H$) and $O(n^3)$ computation (for solving $H\delta = -\nabla f$). For a neural network with $n = 10^9$ parameters, $H$ would require $10^{18}$ bytes -- hence the use of first-order methods (SGD, Adam) and Hessian-free methods (which compute $Hv$ products in $O(n)$ time without forming $H$).
</Remark>

## Chain Rule for Matrices

<Theorem id="thm-matrix-chain-rule" name="Matrix Chain Rule">
For composed functions $f \circ g$ where $g: \mathbb{R}^n \to \mathbb{R}^m$ and $f: \mathbb{R}^m \to \mathbb{R}^p$:

<Equation id="eq-matrix-chain-rule">

$$\frac{\partial (f \circ g)}{\partial x} = \frac{\partial f}{\partial g} \cdot \frac{\partial g}{\partial x} \in \mathbb{R}^{p \times n}$$

</Equation>

This is the Jacobian of $f$ (evaluated at $g(x)$) multiplied by the Jacobian of $g$ (evaluated at $x$). For scalar $f$ (as in backpropagation), the gradient is:

$$\nabla_x (f \circ g) = \left(\frac{\partial g}{\partial x}\right)^\top \nabla_g f$$

</Theorem>

<Example id="ex-chain-rule-layer">
**Gradient through a neural network layer.** For $h = \sigma(Wx + b)$ and scalar loss $\mathcal{L}$, let $z = Wx + b$ and $\bar{h} = \partial \mathcal{L}/\partial h$ (the upstream gradient):

$$\frac{\partial \mathcal{L}}{\partial z} = \bar{h} \odot \sigma'(z) \quad \text{(elementwise, since } \sigma \text{ is applied elementwise)}$$

$$\frac{\partial \mathcal{L}}{\partial W} = \frac{\partial \mathcal{L}}{\partial z} \, x^\top \quad \text{(outer product)}$$

$$\frac{\partial \mathcal{L}}{\partial x} = W^\top \frac{\partial \mathcal{L}}{\partial z} \quad \text{(propagate gradient to input)}$$

$$\frac{\partial \mathcal{L}}{\partial b} = \frac{\partial \mathcal{L}}{\partial z} \quad \text{(bias gradient equals upstream gradient)}$$

The gradient w.r.t. $W$ is always an outer product of the upstream gradient and the layer input. The gradient w.r.t. the input is always a multiplication by $W^\top$. This pattern holds for every linear layer in every neural network.
</Example>

## Matrix-Valued Derivatives

For a scalar function of a matrix $f: \mathbb{R}^{m \times n} \to \mathbb{R}$, the gradient has the **same shape** as the input:

$$\left(\frac{\partial f}{\partial A}\right)_{ij} = \frac{\partial f}{\partial A_{ij}} \in \mathbb{R}^{m \times n}$$

<Table id="tab-matrix-derivatives" caption="Useful matrix derivative identities (all for scalar $f$).">

| Function $f(A)$ | Gradient $\frac{\partial f}{\partial A}$ | Notes |
|------------------|----------------------------------------|-------|
| $\text{tr}(A)$ | $I$ | |
| $\text{tr}(AB)$ | $B^\top$ | Analogue of $d(ax)/dx = a$ |
| $\text{tr}(A^\top B)$ | $B$ | Frobenius inner product |
| $\text{tr}(ABA^\top)$ | $A(B + B^\top)$ | Appears in Gaussian log-likelihood |
| $\text{tr}(A^{-1}B)$ | $-A^{-\top}BA^{-\top}$ | |
| $\log \det(A)$ | $A^{-\top}$ | Key for Gaussian log-likelihood |
| $\det(A)$ | $\det(A) \cdot A^{-\top}$ | Jacobi's formula |
| $a^\top A^{-1}b$ | $-A^{-\top}ab^\top A^{-\top}$ | |

</Table>

<Remark id="rmk-trace-derivative-technique">
**The trace trick for deriving gradients.** Many matrix gradient derivations become simple using the identity $\text{tr}(a^\top b) = a^\top b$ (a scalar equals its own trace) and the cyclic property of trace. For example, to find $\partial \|Ax-b\|^2 / \partial A$:

$$\|Ax-b\|^2 = \text{tr}((Ax-b)^\top(Ax-b)) = \text{tr}(x^\top A^\top Ax - 2b^\top Ax + b^\top b)$$

Using $\partial \text{tr}(X^\top AY)/\partial A = XY^\top$:

$$\frac{\partial}{\partial A} = 2(Ax-b)x^\top$$

This trace-based approach systematically handles most gradient derivations encountered in ML.
</Remark>

## Directional Derivative and Differential

<Definition id="def-directional-derivative" name="Directional Derivative">
The **directional derivative** of $f$ at $x$ in direction $v$ is:

<Equation id="eq-directional-derivative">

$$D_v f(x) = \lim_{t \to 0} \frac{f(x + tv) - f(x)}{t} = \nabla f(x)^\top v$$

</Equation>

This measures the rate of change of $f$ along direction $v$. The gradient is the direction that maximizes the directional derivative (subject to $\|v\| = 1$).
</Definition>

<Remark id="rmk-differential-notation">
**Differential notation** simplifies matrix calculus. The differential $df$ is defined as:

$$df = \nabla f^\top dx = \text{tr}\!\left(\frac{\partial f}{\partial A}^\top dA\right)$$

This notation makes the chain rule automatic: if $f(A) = g(h(A))$, then $df = \frac{\partial g}{\partial h} dh$ and $dh = \frac{\partial h}{\partial A} dA$ (with appropriate products). Identifying the coefficient of $dA$ in the final expression gives $\partial f/\partial A$.
</Remark>

## Notation Summary

<Table id="tab-notation-matcalc" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\nabla_x f$ | Gradient of scalar $f$ w.r.t. vector $x$ (column vector) |
| $J = \partial f / \partial x$ | Jacobian matrix ($m \times n$) |
| $H = \nabla^2 f$ | Hessian matrix ($n \times n$, symmetric) |
| $\text{tr}(A)$ | Trace of $A$ |
| $\det(A)$ | Determinant of $A$ |
| $A^{-\top}$ | $(A^{-1})^\top = (A^\top)^{-1}$ |
| $\delta$ | Perturbation vector |
| $D_v f$ | Directional derivative of $f$ in direction $v$ |
| $df$ | Differential of $f$ |
| $\odot$ | Elementwise (Hadamard) product |
| $\bar{h}$ | Upstream gradient ($\partial \mathcal{L}/\partial h$) |

</Table>
