---
sidebar_position: 3
---

# Eigendecomposition

Eigendecomposition reveals the intrinsic structure of a linear transformation by finding the directions along which the transformation acts as pure scaling. These directions (eigenvectors) and scaling factors (eigenvalues) appear everywhere in ML: the principal components of PCA are eigenvectors of the covariance matrix, the convergence rate of gradient descent depends on eigenvalues of the Hessian, and the connectivity of a graph is encoded in eigenvalues of its Laplacian. This chapter develops eigendecomposition from first principles, proves the spectral theorem for symmetric matrices, and connects these ideas to optimization and learning.

## Eigenvalues and Eigenvectors

<Definition id="def-eigenpair" name="Eigenvalue and Eigenvector">
An **eigenvector** $v \neq 0$ of a square matrix $A \in \mathbb{R}^{n \times n}$ satisfies:

<Equation id="eq-eigenpair">

$$Av = \lambda v$$

</Equation>

where $\lambda \in \mathbb{C}$ is the corresponding **eigenvalue**. The matrix $A$ acts on $v$ by pure scaling: it stretches $v$ by factor $|\lambda|$ and reverses direction if $\lambda < 0$.
</Definition>

Eigenvalues are found by solving the **characteristic equation**:

$$\det(A - \lambda I) = 0$$

This is a degree-$n$ polynomial in $\lambda$, so $A$ has exactly $n$ eigenvalues (counted with algebraic multiplicity, possibly complex).

<Example id="ex-eigen-2x2">
**2x2 eigendecomposition.** For $A = \begin{pmatrix} 3 & 1 \\ 0 & 2 \end{pmatrix}$:

$$\det(A - \lambda I) = (3 - \lambda)(2 - \lambda) = 0 \implies \lambda_1 = 3, \; \lambda_2 = 2$$

For $\lambda_1 = 3$: $(A - 3I)v = 0 \implies v_1 = \begin{pmatrix} 1 \\ 0 \end{pmatrix}$. For $\lambda_2 = 2$: $(A - 2I)v = 0 \implies v_2 = \begin{pmatrix} -1 \\ 1 \end{pmatrix}$.
</Example>

<Remark id="rmk-eigen-interpretation">
**What eigenvalues tell you:**
- $|\lambda_i|$ = how much $A$ stretches along the $i$-th eigenvector direction
- $\text{sign}(\lambda_i)$ = whether $A$ reverses direction along that eigenvector
- $\sum_i \lambda_i = \text{tr}(A)$ = total scaling (sum of stretches)
- $\prod_i \lambda_i = \det(A)$ = volume scaling factor
</Remark>

:::info[Interactive: Linear Transformation]
Adjust the matrix entries to see how a $2 \times 2$ matrix transforms the unit square. The blue and red vectors show where the standard basis vectors $e_1, e_2$ get mapped. Light blue grid lines reveal how the entire plane deforms.
:::

<LinearTransformDemo />

:::info[Interactive: Eigenvectors]
The dashed circle shows the unit circle; the blue ellipse shows its image under $A$. Eigenvectors (red, green) are the directions where $A$ acts as pure scaling. Adjust the matrix to see how eigenvectors and eigenvalues change. When the discriminant is negative, the eigenvalues become complex and the transformation involves rotation.
:::

<EigenDemo />

## Eigendecomposition

<Theorem id="thm-eigendecomp" name="Eigendecomposition (Diagonalization)">
If $A \in \mathbb{R}^{n \times n}$ has $n$ linearly independent eigenvectors, it can be decomposed as:

<Equation id="eq-eigendecomp">

$$A = V \Lambda V^{-1}$$

</Equation>

where $V = [v_1 | v_2 | \cdots | v_n]$ is the matrix of eigenvectors (columns) and $\Lambda = \text{diag}(\lambda_1, \dots, \lambda_n)$ is the diagonal matrix of eigenvalues. Not every matrix is diagonalizable (e.g., $\begin{pmatrix} 0 & 1 \\ 0 & 0 \end{pmatrix}$), but symmetric matrices always are.
</Theorem>

**Why this is useful:**

1. **Matrix powers:** $A^k = V \Lambda^k V^{-1}$, since $\Lambda^k = \text{diag}(\lambda_1^k, \dots, \lambda_n^k)$
2. **Matrix exponential:** $e^A = V e^\Lambda V^{-1} = V \text{diag}(e^{\lambda_1}, \dots, e^{\lambda_n}) V^{-1}$
3. **Matrix functions:** Any function $f(A) = V \text{diag}(f(\lambda_1), \dots, f(\lambda_n)) V^{-1}$
4. **Stability analysis:** A linear dynamical system $x_{t+1} = Ax_t$ converges iff all $|\lambda_i| < 1$

<Example id="ex-power-method">
**Power iteration (worked numerically).** The dominant eigenvector (corresponding to the largest $|\lambda|$) can be found by repeatedly multiplying by $A$ and normalizing:

$$v^{(t+1)} = \frac{A v^{(t)}}{\|A v^{(t)}\|}, \qquad \hat{\lambda}^{(t)} = (v^{(t)})^\top A \, v^{(t)} \;\; (\text{Rayleigh estimate})$$

Take $A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}$, whose true eigenpairs are $\lambda_1 = 3$ with $q_1 = \tfrac{1}{\sqrt 2}(1, 1)$ and $\lambda_2 = 1$ with $q_2 = \tfrac{1}{\sqrt 2}(1, -1)$. Starting from $v^{(0)} = (1, 0)$:

**Step 1 (full guidance).** $A v^{(0)} = (2, 1)$, with $\|A v^{(0)}\| = \sqrt{5} \approx 2.236$, so $v^{(1)} = (0.894, 0.447)$ and $\hat{\lambda}^{(1)} = (v^{(1)})^\top A v^{(1)} \approx 2.976$.

**Step 2 (faded).** Now apply $A$ to $v^{(1)}$, take the norm, and renormalize: $A v^{(1)} = (2.236, 1.789)$, $\|A v^{(1)}\| \approx 2.864$, giving $v^{(2)} = (0.781, 0.625)$ and $\hat{\lambda}^{(2)} \approx 2.997$.

**Step 3 (your turn).** Repeating once more yields $v^{(3)} = (0.733, 0.680)$ and $\hat{\lambda}^{(3)} \approx 2.9997$. The iterate is already converging to $q_1 \approx (0.707, 0.707)$ and the Rayleigh estimate to $\lambda_1 = 3$.

The error contracts at rate $|\lambda_2 / \lambda_1| = 1/3$ per step (the ratio of the two largest eigenvalue magnitudes), which is why three iterations suffice here. Power iteration is the basis of PageRank and is used internally in many SVD algorithms.
</Example>

## Spectral Theorem

<Theorem id="thm-spectral" name="Spectral Theorem for Symmetric Matrices">
If $A \in \mathbb{R}^{n \times n}$ is **symmetric** ($A = A^\top$), then:

1. All eigenvalues are **real**: $\lambda_i \in \mathbb{R}$
2. Eigenvectors corresponding to **distinct eigenvalues are orthogonal**: $\lambda_i \neq \lambda_j \implies v_i^\top v_j = 0$
3. $A$ has a **complete set of orthonormal eigenvectors**, giving the spectral decomposition:

<Equation id="eq-spectral-decomposition">

$$A = Q \Lambda Q^\top = \sum_{i=1}^{n} \lambda_i q_i q_i^\top$$

</Equation>

where $Q = [q_1 | \cdots | q_n]$ is orthogonal ($Q^\top Q = I$) and $\Lambda = \text{diag}(\lambda_1, \dots, \lambda_n)$.
</Theorem>

**Proof sketch (eigenvalues are real).** For symmetric $A$ with eigenvalue $\lambda$ and eigenvector $v$ (possibly complex): $\bar{v}^\top A v = \bar{v}^\top (\lambda v) = \lambda \|v\|^2$. Also $\bar{v}^\top A v = (A^\top \bar{v})^\top v = (A\bar{v})^\top v = (\bar{\lambda} \bar{v})^\top v = \bar{\lambda} \|v\|^2$. Therefore $\lambda = \bar{\lambda}$, so $\lambda \in \mathbb{R}$. $\square$

<Remark id="rmk-spectral-ml">
The spectral theorem is foundational for ML because the key matrices are symmetric:

- **Covariance matrices** $\Sigma$: eigenvalues are variances along principal directions; eigenvectors are the principal components (PCA)
- **Hessians** $\nabla^2 \mathcal{L}$: eigenvalues give curvature along each eigenvector direction; the largest eigenvalue is the Lipschitz constant $\beta$ of the gradient (the smoothness constant)
- **Kernel matrices** $K$: eigenvalues determine the kernel's effective dimensionality; Mercer's theorem guarantees PSD kernels have non-negative eigenvalues
- **Graph Laplacians** $L_{\text{graph}} = D - W$ (where $W$ is the adjacency matrix): eigenvalues encode graph connectivity; the second-smallest eigenvalue (Fiedler value) measures algebraic connectivity. (Here $L$ and $A$ already denote the Cholesky factor and the generic input matrix, so we write $L_{\text{graph}}$ and $W$; the [Graph Neural Networks](../6-advanced-ml-math/3-graph-neural-networks.md) chapter, where no such clash arises, uses the standard $L = D - A$.)
</Remark>

## Positive Definite Matrices

<Definition id="def-positive-definite" name="Positive Definite Matrix">
A symmetric matrix $A \in \mathbb{R}^{n \times n}$ is:
- **Positive definite (PD):** $x^\top A x > 0$ for all $x \neq 0$
- **Positive semi-definite (PSD):** $x^\top A x \geq 0$ for all $x$
- **Negative definite:** $x^\top A x < 0$ for all $x \neq 0$
- **Indefinite:** $x^\top A x$ takes both positive and negative values
</Definition>

<Table id="tab-definiteness" caption="Equivalent characterizations of positive definiteness.">

| Positive Definite ($A \succ 0$) | Positive Semi-Definite ($A \succeq 0$) |
|--------------------------------|---------------------------------------|
| All eigenvalues $\lambda_i > 0$ | All eigenvalues $\lambda_i \geq 0$ |
| All leading minors $> 0$ | All principal minors $\geq 0$ |
| Unique Cholesky: $A = LL^\top$ | Cholesky exists (may have zeros on diagonal) |
| $A = R^\top R$ for full-rank $R$ | $A = R^\top R$ for some $R$ |
| $A^{-1}$ exists and is PD | $A^+$ (pseudoinverse) is PSD |

</Table>

The minors test is asymmetric between the two columns. For PD, Sylvester's criterion needs only the $n$ **leading** principal minors to be positive. For PSD, this is not enough: **all** principal minors (every diagonal submatrix, not just the leading ones) must be nonnegative. For example, $\begin{pmatrix} 0 & 0 \\ 0 & -1 \end{pmatrix}$ has both leading minors equal to $0$ yet is not PSD.

<Remark id="rmk-psd-ml">
**PSD matrices in ML:**
- **Covariance matrices** are always PSD (and PD if data spans the full space)
- $X^\top X$ is PSD for any $X$ (since $z^\top X^\top X z = \|Xz\|^2 \geq 0$)
- **Kernel matrices** are PSD by Mercer's theorem
- **Fisher information matrices** are PSD
- The **Hessian** at a local minimum is PSD ($\nabla^2 \mathcal{L} \succeq 0$)
</Remark>

<Remark id="rmk-hessian-critical">
**Critical point classification via the Hessian.** At a critical point ($\nabla \mathcal{L} = 0$), the nature of the critical point is determined by the eigenvalues of the Hessian $H = \nabla^2 \mathcal{L}$:

| Eigenvalue Structure | Classification |
|---------------------|----------------|
| All $\lambda_i > 0$ | Local minimum |
| All $\lambda_i < 0$ | Local maximum |
| Mixed signs | Saddle point |
| Some $\lambda_i = 0$ | Degenerate (need higher-order analysis) |

In high-dimensional loss landscapes (e.g., $P = 10^9$ parameters), the probability that a random critical point is a local minimum (all $P$ eigenvalues positive) is astronomically small. Most critical points are saddle points, which helps explain why gradient descent does not get stuck in local minima: it slides off saddle points along the directions of negative curvature [@dauphin2014identifying].
</Remark>

## Condition Number

<Definition id="def-condition-number" name="Condition Number">
The **condition number** of a matrix $A$ (with respect to a norm) measures the sensitivity of $Ax = b$ to perturbations. For the 2-norm:

<Equation id="eq-condition-number">

$$\kappa(A) = \|A\| \cdot \|A^{-1}\| = \frac{\sigma_{\max}(A)}{\sigma_{\min}(A)} = \frac{\lambda_{\max}}{\lambda_{\min}} \quad \text{(for symmetric PD)}$$

</Equation>

A perturbation $\delta b$ in the right-hand side causes a relative error bounded by $\frac{\|\delta x\|}{\|x\|} \leq \kappa(A) \frac{\|\delta b\|}{\|b\|}$.
</Definition>

<Table id="tab-conditioning" caption="Effect of condition number on gradient descent and numerical stability.">

| Condition | $\kappa(A)$ | GD Convergence | Numerical Effect |
|-----------|-------------|----------------|------------------|
| Well-conditioned | $\sim 1$ to $10$ | Fast, direct path to minimum | Results accurate to $\sim \epsilon_{\text{mach}}$ |
| Moderately ill-conditioned | $10^3$ to $10^6$ | Oscillation, slow progress | Lose 3 to 6 digits of accuracy |
| Severely ill-conditioned | $> 10^{16}$ | Effectively stuck | Results may be meaningless in FP64 |

</Table>

<Remark id="rmk-preconditioning">
**Preconditioning.** The convergence rate of gradient descent on a quadratic $f(x) = \frac{1}{2}x^\top Ax - b^\top x$ depends on the condition number $\kappa$ of $A$: with the optimal fixed step size $\eta = \frac{2}{\lambda_{\max} + \lambda_{\min}}$, the $A$-norm error contracts per iteration as $\left(\frac{\kappa - 1}{\kappa + 1}\right)^t$ (this rate is specific to that step size; a poorly chosen step size can be far slower or diverge). A **preconditioner** $M \approx A^{-1}$ transforms the system to $MAx = Mb$, reducing the effective condition number to $\kappa(MA) \approx 1$. Adam's per-parameter learning rates act as a diagonal preconditioner: dividing by $\sqrt{\hat{v}_t}$ approximates the inverse diagonal of the Hessian, reducing the effective condition number.
</Remark>

## Rayleigh Quotient

<Definition id="def-rayleigh" name="Rayleigh Quotient">
For a symmetric matrix $A$ and nonzero vector $x$, the **Rayleigh quotient** is:

<Equation id="eq-rayleigh">

$$R(x) = \frac{x^\top A x}{x^\top x}$$

</Equation>

The Rayleigh quotient satisfies $\lambda_{\min} \leq R(x) \leq \lambda_{\max}$ for all $x \neq 0$, with equality at the corresponding eigenvectors. The extremal eigenvalues are:

$$\lambda_{\max} = \max_{x \neq 0} R(x), \qquad \lambda_{\min} = \min_{x \neq 0} R(x)$$

</Definition>

<Remark id="rmk-rayleigh-pca">
PCA can be formulated as maximizing the Rayleigh quotient: the first principal component is $v_1 = \arg\max_{\|v\|=1} v^\top \Sigma v = \arg\max_{\|v\|=1} R_\Sigma(v)$, which is the eigenvector of $\Sigma$ with the largest eigenvalue (direction of maximum variance).
</Remark>

## Gershgorin Circle Theorem

<Theorem id="thm-gershgorin" name="Gershgorin Circle Theorem">
Every eigenvalue of a matrix $A \in \mathbb{R}^{n \times n}$ lies within at least one **Gershgorin disc**:

$$\lambda \in \bigcup_{i=1}^{n} D(A_{ii}, R_i) \quad \text{where} \quad R_i = \sum_{j \neq i} |A_{ij}|$$

Each disc $D(A_{ii}, R_i)$ is centered at the diagonal entry $A_{ii}$ with radius equal to the sum of absolute values of the off-diagonal entries in row $i$.
</Theorem>

<Remark id="rmk-gershgorin-ml">
**Gershgorin in ML.** This theorem provides cheap eigenvalue bounds without computing the eigendecomposition. For a diagonally dominant matrix (where $|A_{ii}| > R_i$ for all $i$), Gershgorin guarantees all eigenvalues have the same sign as the diagonal entries, hence the matrix is positive definite if all diagonal entries are positive and the matrix is diagonally dominant. This is useful for verifying that a kernel matrix or regularized Hessian is PD without computing eigenvalues.
</Remark>

## Notation Summary

<Table id="tab-notation-eigen" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\lambda, \lambda_i$ | Eigenvalue(s) |
| $v, v_i$ | Eigenvector(s) |
| $V$ | Matrix of eigenvectors (columns) |
| $\Lambda$ | Diagonal matrix of eigenvalues |
| $Q$ | Orthogonal matrix of eigenvectors ($Q^\top Q = I$) |
| $\kappa(A)$ | Condition number |
| $R(x)$ | Rayleigh quotient |
| PD, PSD | Positive definite, positive semi-definite |
| $A \succ 0$ | $A$ is positive definite |
| $A \succeq 0$ | $A$ is positive semi-definite |
| $H$ | Hessian matrix |
| $\beta$ | Gradient Lipschitz (smoothness) constant |
| $L$ | Cholesky factor ($A = LL^\top$) |
| $L_{\text{graph}} = D - W$ | Graph Laplacian ($W$ adjacency, $D$ degree matrix) |

</Table>
