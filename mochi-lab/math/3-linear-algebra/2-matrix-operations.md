---
sidebar_position: 2
---

# Matrix Operations

## Matrix Multiplication

<Definition id="def-matmul" name="Matrix Multiplication">
For $A \in \mathbb{R}^{m \times k}$ and $B \in \mathbb{R}^{k \times n}$, the product $C = AB \in \mathbb{R}^{m \times n}$ is defined element-wise as:

<Equation id="eq-matmul">

$$C_{ij} = \sum_{l=1}^{k} A_{il} B_{lj}$$

</Equation>

This requires $2mkn$ FLOPs ($mkn$ multiplications and $mkn$ additions). Matrix multiplication is **not commutative** ($AB \neq BA$ in general) but is **associative** ($(AB)C = A(BC)$) and **distributive** ($A(B+C) = AB + AC$).
</Definition>

### Three Views of Matrix Multiplication

Understanding matrix multiplication from multiple perspectives is essential for ML:

<Table id="tab-matmul-views" caption="Three equivalent views of matrix multiplication $C = AB$.">

| View | Description | Formula |
|------|-------------|---------|
| **Entry-wise** | $C_{ij}$ is the dot product of row $i$ of $A$ and column $j$ of $B$ | $C_{ij} = a_i^\top b_j$ |
| **Column-wise** | Column $j$ of $C$ is a linear combination of columns of $A$ | $C_{:,j} = A b_j = \sum_l B_{lj} A_{:,l}$ |
| **Outer product** | $C$ is a sum of rank-1 matrices | $C = \sum_{l=1}^{k} A_{:,l} B_{l,:}^\top$ |

</Table>

<Example id="ex-matmul-attention">
**Attention as matrix multiplication.** Self-attention computes $\text{Attention}(Q, K, V) = \text{softmax}(QK^\top / \sqrt{d}) \cdot V$.

- $QK^\top$ (entry-wise view): entry $(i,j)$ is the dot-product similarity between query $i$ and key $j$
- $\text{softmax}(QK^\top/\sqrt{d}) \cdot V$ (column-wise view): each output row is a weighted average of value vectors, where the weights are the attention probabilities
- $\sum_j \alpha_{ij} v_j^\top$ (outer product view): the output at position $i$ is built from rank-1 contributions from each value vector
</Example>

<Remark id="rmk-matmul-nn">
A neural network layer $y = Wx + b$ is a matrix-vector product (or batched matrix multiplication $Y = XW^\top + \mathbf{1}b^\top$). The weight matrix $W$ defines a linear map: each row $w_i$ of $W$ computes one output feature as the dot product $w_i^\top x$. The transformation rotates, scales, and projects the input space to the output space.
</Remark>

## Transpose and Symmetry

<Definition id="def-transpose" name="Transpose">
The **transpose** $A^\top$ swaps rows and columns: $(A^\top)_{ij} = A_{ji}$.
</Definition>

Key properties:

$$
(AB)^\top = B^\top A^\top, \quad (A^\top)^\top = A, \quad (A + B)^\top = A^\top + B^\top, \quad (cA)^\top = cA^\top
$$

<Definition id="def-symmetric" name="Symmetric Matrix">
A square matrix $A$ is **symmetric** if $A = A^\top$, and **skew-symmetric** if $A = -A^\top$. Any square matrix can be uniquely decomposed as $A = \frac{1}{2}(A + A^\top) + \frac{1}{2}(A - A^\top)$ (symmetric + skew-symmetric parts).
</Definition>

<Remark id="rmk-symmetric-ml">
Important symmetric matrices in ML:
- **Covariance matrix:** $\Sigma = \frac{1}{n-1}(X - \bar{X})^\top(X - \bar{X})$ is symmetric and positive semi-definite
- **Gram matrix:** $G = X X^\top$ where $G_{ij} = x_i^\top x_j$ (similarities between data points)
- **Hessian:** $H_{ij} = \frac{\partial^2 \mathcal{L}}{\partial \theta_i \partial \theta_j}$ is symmetric (by Schwarz's theorem)
- **Kernel matrix:** $K_{ij} = k(x_i, x_j)$ is symmetric and PSD for valid kernels
</Remark>

## Inverse and Linear Systems

<Definition id="def-inverse" name="Matrix Inverse">
The **inverse** $A^{-1}$ of a square matrix $A \in \mathbb{R}^{n \times n}$ satisfies $A A^{-1} = A^{-1} A = I$. It exists iff $A$ is **non-singular** (equivalently: $\det(A) \neq 0$, $A$ is full rank, $\ker(A) = \{0\}$, all eigenvalues are nonzero).

Key properties: $(AB)^{-1} = B^{-1} A^{-1}$, $(A^\top)^{-1} = (A^{-1})^\top$, $\det(A^{-1}) = 1/\det(A)$.
</Definition>

<Remark id="rmk-no-explicit-inverse">
**Never compute $A^{-1}$ explicitly.** To solve $Ax = b$:

| Factorization | Cost | When to use |
|---------------|------|-------------|
| **LU decomposition** ($A = LU$) | $\frac{2}{3}n^3$ | General square systems |
| **Cholesky** ($A = LL^\top$) | $\frac{1}{3}n^3$ | Symmetric positive definite (covariance, kernel) |
| **QR decomposition** ($A = QR$) | $\frac{4}{3}n^3$ | Least squares, better numerical stability |
| **Iterative (CG, GMRES)** | $O(kn)$ per iteration | Large sparse systems |

Cholesky is $2\times$ faster than LU and numerically more stable for SPD matrices. Always prefer factorization over inversion.
</Remark>

<Definition id="def-pseudo-inverse" name="Moore--Penrose Pseudoinverse">
For any matrix $A \in \mathbb{R}^{m \times n}$ (not necessarily square or invertible), the **pseudoinverse** $A^+ \in \mathbb{R}^{n \times m}$ is the unique matrix satisfying:

1. $AA^+A = A$
2. $A^+AA^+ = A^+$
3. $(AA^+)^\top = AA^+$
4. $(A^+A)^\top = A^+A$

If $A = U\Sigma V^\top$ (SVD), then $A^+ = V\Sigma^+ U^\top$ where $\Sigma^+$ replaces each nonzero $\sigma_i$ with $1/\sigma_i$.
</Definition>

<Remark id="rmk-pseudo-inverse-least-squares">
For overdetermined systems ($m > n$, more equations than unknowns), $A^+ b$ gives the least-squares solution $\arg\min_x \|Ax - b\|^2$. For underdetermined systems ($m < n$), it gives the minimum-norm solution $\arg\min_x \|x\| \text{ s.t. } Ax = b$. This is the solution that L2-regularized gradient descent converges to in overparameterized neural networks.
</Remark>

## Rank

<Definition id="def-rank" name="Matrix Rank">
The **rank** of $A \in \mathbb{R}^{m \times n}$ is the dimension of its column space (equivalently, its row space):

<Equation id="eq-rank">

$$\text{rank}(A) = \dim(\text{col}(A)) = \dim(\text{row}(A))$$

</Equation>

Properties:
- $\text{rank}(A) \leq \min(m, n)$
- $\text{rank}(AB) \leq \min(\text{rank}(A), \text{rank}(B))$
- $\text{rank}(A + B) \leq \text{rank}(A) + \text{rank}(B)$
- $\text{rank}(A^\top A) = \text{rank}(A A^\top) = \text{rank}(A)$
</Definition>

<Remark id="rmk-lora-low-rank">
**Low-rank structure in ML.** Many matrices encountered in ML are approximately low-rank:

- **Weight updates during fine-tuning** have low intrinsic rank [@hu2022lora]. LoRA exploits this by parameterizing $\Delta W = BA$ where $B \in \mathbb{R}^{d \times r}$, $A \in \mathbb{R}^{r \times d}$ with $r \ll d$, reducing parameters from $d^2$ to $2dr$.
- **Attention matrices** $\text{softmax}(QK^\top/\sqrt{d})$ often have rapidly decaying singular values, motivating low-rank attention approximations.
- **Embeddings** with $r$ latent factors naturally produce rank-$r$ matrices (e.g., matrix factorization in recommender systems).
</Remark>

## Trace

<Definition id="def-trace" name="Trace">
The **trace** of a square matrix $A \in \mathbb{R}^{n \times n}$ is the sum of its diagonal elements:

<Equation id="eq-trace">

$$\text{tr}(A) = \sum_{i=1}^{n} A_{ii}$$

</Equation>
</Definition>

Key properties:
- **Cyclic permutation:** $\text{tr}(ABC) = \text{tr}(CAB) = \text{tr}(BCA)$ (but $\neq \text{tr}(BAC)$ in general)
- **Sum of eigenvalues:** $\text{tr}(A) = \sum_i \lambda_i$
- **Frobenius inner product:** $\text{tr}(A^\top B) = \sum_{ij} A_{ij} B_{ij} = \langle A, B \rangle_F$
- **Frobenius norm:** $\|A\|_F^2 = \text{tr}(A^\top A) = \sum_i \sigma_i^2$
- **Linearity:** $\text{tr}(\alpha A + \beta B) = \alpha \text{tr}(A) + \beta \text{tr}(B)$

<Remark id="rmk-trace-ml">
The cyclic property $\text{tr}(AB) = \text{tr}(BA)$ is used constantly in ML derivations. For example, the MSE loss $\|Y - XW\|_F^2 = \text{tr}((Y-XW)^\top(Y-XW))$, and matrix calculus identities for gradients are most easily derived using trace notation.
</Remark>

## Determinant

<Definition id="def-determinant" name="Determinant">
The **determinant** $\det(A)$ of a square matrix $A$ measures the signed volume scaling of the linear transformation. For $2 \times 2$: $\det \begin{pmatrix} a & b \\ c & d \end{pmatrix} = ad - bc$.
</Definition>

Key properties:
- $\det(AB) = \det(A)\det(B)$
- $\det(A^{-1}) = 1/\det(A)$
- $\det(A^\top) = \det(A)$
- $\det(\alpha A) = \alpha^n \det(A)$ for $A \in \mathbb{R}^{n \times n}$
- $\det(A) = \prod_{i=1}^{n} \lambda_i$ (product of eigenvalues)

<Remark id="rmk-log-det">
**Log-determinant in ML.** The multivariate Gaussian log-likelihood contains $\log\det(\Sigma)$:

$$\log p(x | \mu, \Sigma) = -\frac{1}{2}\left(n\log(2\pi) + \log\det(\Sigma) + (x-\mu)^\top \Sigma^{-1}(x-\mu)\right)$$

Computing $\log\det(\Sigma)$ directly is numerically unstable (the determinant can overflow or underflow). Instead, use the Cholesky factorization $\Sigma = LL^\top$:

$$\log\det(\Sigma) = \log\det(LL^\top) = 2\log\det(L) = 2\sum_{i=1}^n \log L_{ii}$$

This is both numerically stable and efficient ($O(n^3/3)$ for the Cholesky factorization plus $O(n)$ for the sum).
</Remark>

## Special Matrix Types

<Table id="tab-special-matrices" caption="Special matrix types commonly encountered in ML.">

| Type | Definition | Properties | ML Example |
|------|-----------|------------|------------|
| **Diagonal** | $A_{ij} = 0$ for $i \neq j$ | $A^{-1}$ is diagonal; $\det = \prod a_{ii}$ | Scaling, $\Lambda$ in eigendecomp |
| **Orthogonal** | $Q^\top Q = QQ^\top = I$ | Preserves norms and angles; $\det = \pm 1$ | $U, V$ in SVD; rotation matrices |
| **Symmetric** | $A = A^\top$ | Real eigenvalues; orthogonal eigenvectors | Covariance, Hessian, kernel matrices |
| **SPD** | Symmetric $+$ all $\lambda_i > 0$ | Unique Cholesky; defines an inner product | Covariance, Fisher information |
| **Sparse** | Most entries are zero | Efficient storage and multiplication | Adjacency matrices, attention masks |
| **Toeplitz** | Constant along diagonals | Matmul via FFT in $O(n \log n)$ | 1D convolution |
| **Block diagonal** | Diagonal blocks, zeros elsewhere | Operations decompose per block | Multi-head attention parameters |

</Table>

## Notation Summary

<Table id="tab-notation-matops" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $A^\top$ | Transpose of $A$ |
| $A^{-1}$ | Inverse of $A$ |
| $A^+$ | Moore--Penrose pseudoinverse |
| $I$ or $I_n$ | $n \times n$ identity matrix |
| $\text{rank}(A)$ | Rank (dimension of column space) |
| $\text{tr}(A)$ | Trace (sum of diagonal elements) |
| $\det(A)$ | Determinant |
| $\sigma_i$ | Singular values |
| $\lambda_i$ | Eigenvalues |
| $\|A\|_F$ | Frobenius norm |
| $\|A\|_2$ | Spectral norm ($= \sigma_{\max}$) |
| $L, U$ | Lower/upper triangular (LU decomposition) |
| $Q, R$ | Orthogonal/upper triangular (QR decomposition) |

</Table>
