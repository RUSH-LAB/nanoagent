---
sidebar_position: 3
---

# Eigendecomposition

## Eigenvalues and Eigenvectors

<Definition id="def-eigenpair" name="Eigenvalue and Eigenvector">
An **eigenvector** $v$ of a square matrix $A$ satisfies:

<Equation id="eq-eigenpair">

$$Av = \lambda v$$

</Equation>

where $\lambda$ is the corresponding **eigenvalue**. The matrix $A$ stretches $v$ by factor $\lambda$ without changing its direction. Eigenvalues are found by solving the **characteristic equation**:

$$
\det(A - \lambda I) = 0
$$

An $n \times n$ matrix has at most $n$ eigenvalues (counted with multiplicity).
</Definition>

## Eigendecomposition

<Theorem id="thm-eigendecomp" name="Eigendecomposition">
If $A \in \mathbb{R}^{n \times n}$ has $n$ linearly independent eigenvectors, it can be decomposed as:

<Equation id="eq-eigendecomp">

$$A = V \Lambda V^{-1}$$

</Equation>

where $V = [v_1 | v_2 | \cdots | v_n]$ is the matrix of eigenvectors and $\Lambda = \text{diag}(\lambda_1, \dots, \lambda_n)$.
</Theorem>

This makes matrix powers efficient: $A^k = V \Lambda^k V^{-1}$.

<Remark id="rmk-eigendecomp-pca">
Eigendecomposition reveals the principal axes along which a linear transformation acts by simple scaling. In PCA, the eigenvectors of the covariance matrix are the directions of maximum variance.
</Remark>

## Spectral Theorem

<Theorem id="thm-spectral" name="Spectral Theorem">
For **symmetric** (or Hermitian) matrices, eigendecomposition has stronger properties:

1. All eigenvalues are **real**
2. Eigenvectors corresponding to distinct eigenvalues are **orthogonal**
3. The matrix can be diagonalized by an orthogonal matrix: $A = Q \Lambda Q^\top$ where $Q^\top Q = I$

This is called the **spectral decomposition**. It guarantees that symmetric matrices have a complete set of orthonormal eigenvectors.
</Theorem>

<Remark id="rmk-spectral-ml">
Covariance matrices, Hessians, and kernel matrices are all symmetric. The spectral theorem guarantees they have real eigenvalues and orthogonal eigenvectors, which is why PCA, spectral clustering, and second-order optimization methods work.
</Remark>

## Positive Definite Matrices

<Definition id="def-positive-definite" name="Positive Definite Matrix">
A symmetric matrix $A$ is **positive definite** (PD) if $x^\top A x > 0$ for all $x \neq 0$, equivalently all eigenvalues $\lambda_i > 0$.
</Definition>

<Table id="tab-definiteness" caption="Classification of symmetric matrices by definiteness.">

| Property | Condition | Eigenvalues |
|----------|-----------|-------------|
| Positive definite (PD) | $x^\top A x > 0$ for all $x \neq 0$ | All $\lambda_i > 0$ |
| Positive semi-definite (PSD) | $x^\top A x \geq 0$ for all $x$ | All $\lambda_i \geq 0$ |
| Negative definite | $x^\top A x < 0$ for all $x \neq 0$ | All $\lambda_i < 0$ |
| Indefinite | $x^\top A x$ takes both signs | Mixed signs |

</Table>

Equivalent conditions for PD: all eigenvalues positive, all leading minors positive, $A = R^\top R$ for some full-rank $R$ (Cholesky factorization).

<Remark id="rmk-hessian-critical">
The Hessian $H = \nabla^2 \mathcal{L}$ classifies critical points. If $H$ is PD, the point is a local minimum. If $H$ is indefinite (has both positive and negative eigenvalues), it is a saddle point. In high-dimensional loss landscapes, saddle points vastly outnumber local minima.
</Remark>

## Condition Number

<Definition id="def-condition-number" name="Condition Number">
The **condition number** of a matrix is:

<Equation id="eq-condition-number">

$$\kappa(A) = \frac{\lambda_{\max}}{\lambda_{\min}} = \frac{\sigma_{\max}}{\sigma_{\min}}$$

</Equation>

It measures how sensitive $Ax = b$ is to perturbations. A large $\kappa$ means the problem is ill-conditioned.
</Definition>

<Table id="tab-conditioning" caption="Effect of condition number on gradient descent convergence.">

| Condition | $\kappa(A)$ | Effect |
|-----------|-------------|--------|
| Well-conditioned | $\sim 1$ | Gradient descent converges quickly |
| Ill-conditioned | $\gg 1$ | Gradient descent oscillates, slow convergence |

</Table>

<Remark id="rmk-preconditioning">
The condition number of the Hessian determines the convergence rate of gradient descent. For $\kappa = L/\mu$ (ratio of Lipschitz constant to strong convexity), GD converges as $O((\kappa - 1)/(\kappa + 1))^t$. Preconditioning (e.g., Adam's per-parameter learning rates) effectively reduces the condition number.
</Remark>

## Notation Summary

<Table id="tab-notation-eigen" caption="Notation used in eigendecomposition.">

| Symbol | Meaning |
|--------|---------|
| $\lambda$ | Eigenvalue |
| $v$ | Eigenvector |
| $V$ | Matrix of eigenvectors |
| $\Lambda$ | Diagonal matrix of eigenvalues |
| $Q$ | Orthogonal matrix ($Q^\top Q = I$) |
| $\kappa(A)$ | Condition number |
| PD, PSD | Positive definite, positive semi-definite |
| $H$ | Hessian matrix |

</Table>
