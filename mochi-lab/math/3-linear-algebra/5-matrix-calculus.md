---
sidebar_position: 5
---

# Matrix Calculus

## Gradient of a Scalar Function

<Definition id="def-gradient" name="Gradient">
For a scalar-valued function $f: \mathbb{R}^n \to \mathbb{R}$, the **gradient** is the column vector of partial derivatives:

<Equation id="eq-gradient">

$$\nabla_x f = \begin{bmatrix} \frac{\partial f}{\partial x_1} \\ \vdots \\ \frac{\partial f}{\partial x_n} \end{bmatrix} \in \mathbb{R}^n$$

</Equation>

The gradient points in the direction of steepest ascent. Its magnitude $\|\nabla f\|$ is the rate of change in that direction.
</Definition>

## Common Gradient Identities

These identities are used constantly in ML derivations. Let $a, x \in \mathbb{R}^n$ and $A \in \mathbb{R}^{n \times n}$:

<Table id="tab-gradient-identities" caption="Common gradient identities for ML derivations.">

| Function $f(x)$ | Gradient $\nabla_x f$ |
|------------------|----------------------|
| $a^\top x$ | $a$ |
| $x^\top A x$ | $(A + A^\top) x$ |
| $x^\top A x$ ($A$ symmetric) | $2Ax$ |
| $\|x\|_2^2 = x^\top x$ | $2x$ |
| $\|Ax - b\|_2^2$ | $2A^\top(Ax - b)$ |

</Table>

<Remark id="rmk-normal-equation-gradient">
The gradient of $\|Ax - b\|_2^2$ with respect to $x$ gives the normal equation $A^\top A x = A^\top b$ when set to zero. This is the closed-form solution for linear regression.
</Remark>

## Jacobian

<Definition id="def-jacobian-matcalc" name="Jacobian">
For a vector-valued function $f: \mathbb{R}^n \to \mathbb{R}^m$, the **Jacobian** is the $m \times n$ matrix:

<Equation id="eq-jacobian-matcalc">

$$J = \frac{\partial f}{\partial x} = \begin{bmatrix} \frac{\partial f_1}{\partial x_1} & \cdots & \frac{\partial f_1}{\partial x_n} \\ \vdots & \ddots & \vdots \\ \frac{\partial f_m}{\partial x_1} & \cdots & \frac{\partial f_m}{\partial x_n} \end{bmatrix}$$

</Equation>

The Jacobian is the best linear approximation: $f(x + \delta) \approx f(x) + J \delta$.
</Definition>

## Hessian

<Definition id="def-hessian" name="Hessian">
For $f: \mathbb{R}^n \to \mathbb{R}$, the **Hessian** is the $n \times n$ matrix of second derivatives:

<Equation id="eq-hessian">

$$H_{ij} = \frac{\partial^2 f}{\partial x_i \partial x_j}$$

</Equation>

The Hessian is symmetric (by Schwarz's theorem) and characterizes the local curvature of $f$.
</Definition>

The second-order Taylor expansion is:

<Equation id="eq-taylor-second-order">

$$f(x + \delta) \approx f(x) + \nabla f^\top \delta + \frac{1}{2} \delta^\top H \delta$$

</Equation>

<Remark id="rmk-newton-method">
Newton's method uses the Hessian to take optimal steps: $\delta^* = -H^{-1} \nabla f$. This converges quadratically near a minimum but costs $O(n^2)$ memory and $O(n^3)$ computation. For neural networks with millions of parameters, this is infeasible -- hence the popularity of first-order methods (SGD, Adam).
</Remark>

## Chain Rule for Matrices

For composed functions $f(g(x))$, the chain rule generalizes:

$$
\frac{\partial f}{\partial x} = \frac{\partial f}{\partial g} \cdot \frac{\partial g}{\partial x}
$$

<Example id="ex-chain-rule-layer">
For a scalar loss $\mathcal{L}$ composed through layers $h = g(Wx + b)$:

$$
\frac{\partial \mathcal{L}}{\partial W} = \frac{\partial \mathcal{L}}{\partial h} \cdot \frac{\partial h}{\partial (Wx+b)} \cdot \frac{\partial (Wx+b)}{\partial W}
$$

The last term is: $\frac{\partial (Wx + b)}{\partial W} = x^\top$ (when computing the outer product form).
</Example>

## Matrix-Valued Derivatives

For a scalar function of a matrix $f: \mathbb{R}^{m \times n} \to \mathbb{R}$, the gradient has the same shape as the input:

$$
\left(\frac{\partial f}{\partial A}\right)_{ij} = \frac{\partial f}{\partial A_{ij}}
$$

Useful identities for $A \in \mathbb{R}^{m \times n}$:

<Table id="tab-matrix-derivatives" caption="Useful matrix derivative identities.">

| Function $f(A)$ | Gradient $\frac{\partial f}{\partial A}$ |
|------------------|----------------------------------------|
| $\text{tr}(A)$ | $I$ |
| $\text{tr}(AB)$ | $B^\top$ |
| $\text{tr}(A^\top B)$ | $B$ |
| $\text{tr}(ABA^\top)$ | $(B + B^\top)A$ |
| $\log \det(A)$ | $A^{-\top}$ |

</Table>

<Remark id="rmk-trace-derivative">
The identity $\frac{\partial}{\partial A} \text{tr}(AB) = B^\top$ is the matrix analogue of $\frac{d}{dx}(ax) = a$. Most neural network gradient derivations can be reduced to trace derivative identities.
</Remark>

## Notation Summary

<Table id="tab-notation-matcalc" caption="Notation used in matrix calculus.">

| Symbol | Meaning |
|--------|---------|
| $\nabla_x f$ | Gradient of $f$ w.r.t. $x$ |
| $J$ | Jacobian matrix |
| $H$ | Hessian matrix |
| $\text{tr}(A)$ | Trace of $A$ |
| $\det(A)$ | Determinant of $A$ |
| $A^{-\top}$ | $(A^{-1})^\top = (A^\top)^{-1}$ |
| $\delta$ | Perturbation vector |

</Table>
