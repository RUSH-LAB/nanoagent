---
sidebar_position: 3
---

# Eigendecomposition

## Eigenvalues and Eigenvectors

An **eigenvector** $v$ of a square matrix $A$ satisfies:

$$
Av = \lambda v
$$

where $\lambda$ is the corresponding **eigenvalue**. The matrix $A$ stretches $v$ by factor $\lambda$ without changing its direction. Eigenvalues are found by solving the **characteristic equation**:

$$
\det(A - \lambda I) = 0
$$

An $n \times n$ matrix has at most $n$ eigenvalues (counted with multiplicity).

## Eigendecomposition

If $A \in \mathbb{R}^{n \times n}$ has $n$ linearly independent eigenvectors, it can be decomposed as:

$$
A = V \Lambda V^{-1}
$$

where $V = [v_1 | v_2 | \cdots | v_n]$ is the matrix of eigenvectors and $\Lambda = \text{diag}(\lambda_1, \dots, \lambda_n)$. This makes matrix powers efficient: $A^k = V \Lambda^k V^{-1}$.

**Key insight:** Eigendecomposition reveals the principal axes along which a linear transformation acts by simple scaling. In PCA, the eigenvectors of the covariance matrix are the directions of maximum variance.

## Spectral Theorem

For **symmetric** (or Hermitian) matrices, eigendecomposition has stronger properties:

1. All eigenvalues are **real**
2. Eigenvectors corresponding to distinct eigenvalues are **orthogonal**
3. The matrix can be diagonalized by an orthogonal matrix: $A = Q \Lambda Q^\top$ where $Q^\top Q = I$

This is called the **spectral decomposition**. It guarantees that symmetric matrices have a complete set of orthonormal eigenvectors.

**Key insight:** Covariance matrices, Hessians, and kernel matrices are all symmetric. The spectral theorem guarantees they have real eigenvalues and orthogonal eigenvectors, which is why PCA, spectral clustering, and second-order optimization methods work.

## Positive Definite Matrices

A symmetric matrix $A$ is:

| Property | Condition | Eigenvalues |
|----------|-----------|-------------|
| Positive definite (PD) | $x^\top A x > 0$ for all $x \neq 0$ | All $\lambda_i > 0$ |
| Positive semi-definite (PSD) | $x^\top A x \geq 0$ for all $x$ | All $\lambda_i \geq 0$ |
| Negative definite | $x^\top A x < 0$ for all $x \neq 0$ | All $\lambda_i < 0$ |
| Indefinite | $x^\top A x$ takes both signs | Mixed signs |

Equivalent conditions for PD: all eigenvalues positive, all leading minors positive, $A = R^\top R$ for some full-rank $R$ (Cholesky factorization).

**Key insight:** The Hessian $H = \nabla^2 \mathcal{L}$ classifies critical points. If $H$ is PD, the point is a local minimum. If $H$ is indefinite (has both positive and negative eigenvalues), it is a saddle point. In high-dimensional loss landscapes, saddle points vastly outnumber local minima.

## Condition Number

The **condition number** of a matrix is:

$$
\kappa(A) = \frac{\lambda_{\max}}{\lambda_{\min}} = \frac{\sigma_{\max}}{\sigma_{\min}}
$$

It measures how sensitive $Ax = b$ is to perturbations. A large $\kappa$ means the problem is ill-conditioned.

| Condition | $\kappa(A)$ | Effect |
|-----------|-------------|--------|
| Well-conditioned | $\sim 1$ | Gradient descent converges quickly |
| Ill-conditioned | $\gg 1$ | Gradient descent oscillates, slow convergence |

**Key insight:** The condition number of the Hessian determines the convergence rate of gradient descent. For $\kappa = L/\mu$ (ratio of Lipschitz constant to strong convexity), GD converges as $O((\kappa - 1)/(\kappa + 1))^t$. Preconditioning (e.g., Adam's per-parameter learning rates) effectively reduces the condition number.

## Notation Summary

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
