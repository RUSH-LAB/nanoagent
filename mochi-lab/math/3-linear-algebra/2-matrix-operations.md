---
sidebar_position: 2
---

# Matrix Operations

## Matrix Multiplication

<Definition id="def-matmul" name="Matrix Multiplication">
For $A \in \mathbb{R}^{m \times k}$ and $B \in \mathbb{R}^{k \times n}$, the product $C = AB \in \mathbb{R}^{m \times n}$ is:

<Equation id="eq-matmul">

$$C_{ij} = \sum_{l=1}^{k} A_{il} B_{lj}$$

</Equation>

This requires $2mkn$ FLOPs. Matrix multiplication is **not commutative** ($AB \neq BA$ in general) but is **associative** ($(AB)C = A(BC)$).
</Definition>

Three equivalent views:

- **Entry-wise:** $C_{ij}$ is the dot product of row $i$ of $A$ and column $j$ of $B$
- **Column-wise:** column $j$ of $C$ is a linear combination of columns of $A$, weighted by column $j$ of $B$
- **Outer product:** $C = \sum_{l=1}^{k} A_{:,l} B_{l,:}$ (sum of rank-1 matrices)

<Remark id="rmk-matmul-nn">
A neural network layer $y = Wx + b$ is a matrix-vector product followed by translation. The weight matrix $W$ defines a linear transformation: it rotates, scales, and projects the input space.
</Remark>

## Transpose and Symmetry

The **transpose** $A^\top$ swaps rows and columns: $(A^\top)_{ij} = A_{ji}$. Key properties:

$$
(AB)^\top = B^\top A^\top, \quad (A^\top)^\top = A, \quad (A + B)^\top = A^\top + B^\top
$$

A matrix is **symmetric** if $A = A^\top$. Covariance matrices $\Sigma = \frac{1}{n}X^\top X$ are always symmetric and positive semi-definite.

## Inverse

<Definition id="def-inverse" name="Matrix Inverse">
The **inverse** $A^{-1}$ of a square matrix $A$ satisfies $A A^{-1} = A^{-1} A = I$. It exists iff $\det(A) \neq 0$ (i.e., $A$ is non-singular).

$$
(AB)^{-1} = B^{-1} A^{-1}, \quad (A^\top)^{-1} = (A^{-1})^\top
$$
</Definition>

<Remark id="rmk-no-explicit-inverse">
In practice, never compute $A^{-1}$ explicitly. To solve $Ax = b$, use LU or Cholesky factorization, which is numerically stable and $O(n^3)$ vs $O(n^3)$ for inversion but with better constants and stability.
</Remark>

## Rank

<Definition id="def-rank" name="Matrix Rank">
The **rank** of $A$ is the dimension of its column space (equivalently, row space):

<Equation id="eq-rank">

$$\text{rank}(A) = \dim(\text{col}(A)) = \dim(\text{row}(A))$$

</Equation>

Properties: $\text{rank}(A) \leq \min(m, n)$, $\text{rank}(AB) \leq \min(\text{rank}(A), \text{rank}(B))$. A matrix is **full rank** if $\text{rank}(A) = \min(m, n)$.
</Definition>

<Remark id="rmk-lora-low-rank">
LoRA (Low-Rank Adaptation) [@hu2022lora] adds a trainable $\Delta W = BA$ where $B \in \mathbb{R}^{d \times r}$, $A \in \mathbb{R}^{r \times d}$ with $r \ll d$. This exploits the observation that weight updates during fine-tuning have low intrinsic rank.
</Remark>

## Trace

<Definition id="def-trace" name="Trace">
The **trace** is the sum of diagonal elements:

<Equation id="eq-trace">

$$\text{tr}(A) = \sum_{i=1}^{n} A_{ii}$$

</Equation>

Key properties: $\text{tr}(AB) = \text{tr}(BA)$ (cyclic), $\text{tr}(A) = \sum_i \lambda_i$ (sum of eigenvalues), $\text{tr}(A^\top B) = \sum_{ij} A_{ij} B_{ij}$ (Frobenius inner product).
</Definition>

<Remark id="rmk-frobenius-trace">
The Frobenius norm squared equals the trace: $\|A\|_F^2 = \text{tr}(A^\top A)$. This connects matrix norms to eigenvalues since $\|A\|_F^2 = \sum_i \sigma_i^2$.
</Remark>

## Determinant

<Definition id="def-determinant" name="Determinant">
The **determinant** $\det(A)$ measures the signed volume scaling of the linear transformation:

$$
\det(AB) = \det(A)\det(B), \quad \det(A^{-1}) = \frac{1}{\det(A)}, \quad \det(A) = \prod_{i=1}^{n} \lambda_i
$$
</Definition>

<Remark id="rmk-log-det">
The log-determinant appears in the Gaussian log-likelihood: $\log p(x) = -\frac{1}{2}\left(n\log(2\pi) + \log\det(\Sigma) + (x-\mu)^\top \Sigma^{-1}(x-\mu)\right)$. Computing $\log\det(\Sigma)$ efficiently via Cholesky: $\log\det(\Sigma) = 2\sum_i \log L_{ii}$ where $\Sigma = LL^\top$.
</Remark>

## Notation Summary

<Table id="tab-notation-matops" caption="Notation used in matrix operations.">

| Symbol | Meaning |
|--------|---------|
| $A^\top$ | Transpose of $A$ |
| $A^{-1}$ | Inverse of $A$ |
| $I$ | Identity matrix |
| $\text{rank}(A)$ | Rank (dimension of column space) |
| $\text{tr}(A)$ | Trace (sum of diagonal elements) |
| $\det(A)$ | Determinant |
| $\sigma_i$ | Singular values |
| $\lambda_i$ | Eigenvalues |

</Table>
