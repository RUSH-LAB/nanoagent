---
sidebar_position: 1
---

# Vectors and Matrices

## Vector Spaces

<Definition id="def-vector-space" name="Vector Space">
A **vector space** $V$ over $\mathbb{R}$ is a set equipped with two operations -- vector addition and scalar multiplication -- satisfying the following axioms:

1. **Closure:** $u + v \in V$ and $\alpha v \in V$ for all $u, v \in V$, $\alpha \in \mathbb{R}$
2. **Associativity:** $(u + v) + w = u + (v + w)$
3. **Commutativity:** $u + v = v + u$
4. **Additive identity:** There exists $0 \in V$ such that $v + 0 = v$
5. **Additive inverse:** For each $v$, there exists $-v$ such that $v + (-v) = 0$
6. **Scalar distributivity:** $\alpha(u + v) = \alpha u + \alpha v$
7. **Vector distributivity:** $(\alpha + \beta)v = \alpha v + \beta v$
8. **Scalar associativity:** $\alpha(\beta v) = (\alpha\beta) v$
9. **Scalar identity:** $1 \cdot v = v$

The standard example is $\mathbb{R}^n$ -- the space of $n$-tuples of real numbers.
</Definition>

In machine learning, a data point is a vector $x \in \mathbb{R}^n$ where $n$ is the number of features. A dataset of $m$ points is a matrix $X \in \mathbb{R}^{m \times n}$ where each row is a data point.

<Definition id="def-subspace" name="Subspace">
A **subspace** $W \subseteq V$ is a subset that is itself a vector space under the same operations. Equivalently, $W$ is a subspace iff it is closed under addition and scalar multiplication: for all $u, w \in W$ and $\alpha \in \mathbb{R}$, $u + w \in W$ and $\alpha w \in W$. Every subspace contains the zero vector.
</Definition>

<Example id="ex-subspace-column">
**Column space as subspace.** The column space of a matrix $A \in \mathbb{R}^{m \times n}$ is $\text{col}(A) = \{Ax : x \in \mathbb{R}^n\}$, the set of all linear combinations of the columns of $A$. This is a subspace of $\mathbb{R}^m$ with dimension equal to $\text{rank}(A)$. In linear regression, the predicted values $\hat{y} = X\hat{\theta}$ always lie in the column space of $X$.
</Example>

## Dot Product and Inner Products

<Definition id="def-dot-product" name="Dot Product">
The **dot product** (Euclidean inner product) of two vectors $x, y \in \mathbb{R}^n$ is:

<Equation id="eq-dot-product">

$$x \cdot y = x^\top y = \sum_{i=1}^{n} x_i y_i = \|x\| \|y\| \cos \theta$$

</Equation>

where $\theta$ is the angle between them. More generally, an **inner product** $\langle \cdot, \cdot \rangle$ is any function $V \times V \to \mathbb{R}$ that is:
- **Bilinear:** linear in each argument
- **Symmetric:** $\langle x, y \rangle = \langle y, x \rangle$
- **Positive definite:** $\langle x, x \rangle > 0$ for $x \neq 0$
</Definition>

<Remark id="rmk-dot-product-ml">
The dot product is the most fundamental operation in ML:

- **Cosine similarity:** $\cos\theta = \frac{x^\top y}{\|x\|\|y\|}$ measures angular similarity between embeddings. Used for retrieval, clustering, and nearest-neighbor search.
- **Attention scores:** $\text{score}(q, k) = q^\top k / \sqrt{d}$ is a scaled dot product between query and key vectors.
- **Kernel methods:** Replace $x^\top y$ with a kernel function $k(x,y)$ that implicitly computes the dot product in a higher-dimensional feature space.
- **Linear layers:** $y = Wx + b$ computes $n$ dot products (one per output dimension) between the weight rows and the input.
</Remark>

<Definition id="def-mahalanobis" name="Mahalanobis Inner Product">
For a positive definite matrix $M$, the **Mahalanobis inner product** is $\langle x, y \rangle_M = x^\top M y$, and the induced norm is $\|x\|_M = \sqrt{x^\top M x}$. When $M = \Sigma^{-1}$ (inverse covariance), the Mahalanobis distance $\|x - \mu\|_{\Sigma^{-1}}$ measures how many "standard deviations" $x$ is from $\mu$, accounting for correlations between features.
</Definition>

## Norms

<Definition id="def-norm" name="Norm">
A **norm** $\|\cdot\|: V \to \mathbb{R}_{\geq 0}$ measures vector magnitude. It must satisfy:

1. **Positive definiteness:** $\|x\| = 0 \iff x = 0$
2. **Homogeneity:** $\|\alpha x\| = |\alpha| \|x\|$
3. **Triangle inequality:** $\|x + y\| \leq \|x\| + \|y\|$

The **$L_p$ norm** is $\|x\|_p = \left(\sum_i |x_i|^p\right)^{1/p}$ for $p \geq 1$.
</Definition>

<Table id="tab-norms" caption="Common norms, their formulas, geometric shapes, and uses in ML.">

| Norm | Formula | Unit Ball Shape | ML Application |
|------|---------|-----------------|---------------|
| $L_0$ (counting) | $\sum_i \mathbf{1}[x_i \neq 0]$ | Cross-polytope corners | Sparsity (not a true norm) |
| $L_1$ (Manhattan) | $\sum_i |x_i|$ | Diamond (cross-polytope) | Lasso/L1 regularization, promotes sparsity |
| $L_2$ (Euclidean) | $\sqrt{\sum_i x_i^2}$ | Circle (sphere) | Ridge/L2 regularization, distances |
| $L_\infty$ (max) | $\max_i |x_i|$ | Cube (hypercube) | Adversarial robustness ($\ell_\infty$ attacks) |
| Frobenius | $\sqrt{\sum_{i,j} a_{ij}^2}$ | -- | Matrix regularization, $\|A\|_F^2 = \text{tr}(A^\top A)$ |
| Spectral | $\sigma_{\max}(A)$ | -- | Spectral normalization, Lipschitz bounds |

</Table>

<Remark id="rmk-norm-equivalence">
**Norm equivalence.** In finite dimensions, all norms are equivalent up to constant factors: there exist $c, C > 0$ such that $c\|x\|_a \leq \|x\|_b \leq C\|x\|_a$. In $\mathbb{R}^n$: $\|x\|_2 \leq \|x\|_1 \leq \sqrt{n}\|x\|_2$ and $\|x\|_\infty \leq \|x\|_2 \leq \sqrt{n}\|x\|_\infty$. This means convergence in one norm implies convergence in all norms (in finite dimensions).
</Remark>

## Orthogonality and Projection

<Definition id="def-orthogonal" name="Orthogonality">
Vectors $x$ and $y$ are **orthogonal** ($x \perp y$) if $x^\top y = 0$. A set of vectors $\{v_1, \dots, v_k\}$ is:
- **Orthogonal** if $v_i^\top v_j = 0$ for all $i \neq j$
- **Orthonormal** if additionally $\|v_i\| = 1$, i.e., $v_i^\top v_j = \delta_{ij}$ (Kronecker delta)
</Definition>

<Theorem id="thm-projection" name="Orthogonal Projection">
The **orthogonal projection** of $b$ onto a vector $a$ is the closest point to $b$ on the line spanned by $a$:

<Equation id="eq-projection">

$$\text{proj}_a(b) = \frac{a^\top b}{a^\top a} a = \frac{a^\top b}{\|a\|^2} a$$

</Equation>

The residual $b - \text{proj}_a(b)$ is orthogonal to $a$ (this is the defining property of orthogonal projection).

More generally, the projection onto a subspace spanned by the columns of $A$:

- If $A$ has **orthonormal columns** ($A^\top A = I$): $\text{proj}(b) = A A^\top b$
- For **general $A$**: $\text{proj}(b) = A(A^\top A)^{-1}A^\top b$

The matrix $P = A(A^\top A)^{-1}A^\top$ is the **projection matrix**. It satisfies $P^2 = P$ (idempotent) and $P^\top = P$ (symmetric).
</Theorem>

<Remark id="rmk-normal-equation">
**Linear regression as projection.** The normal equation $\hat{\theta} = (X^\top X)^{-1} X^\top y$ computes the parameters such that $\hat{y} = X\hat{\theta}$ is the orthogonal projection of $y$ onto the column space of $X$. The residual $y - \hat{y}$ is orthogonal to every column of $X$, meaning $X^\top(y - X\hat{\theta}) = 0$. This is the *least-squares* solution -- it minimizes $\|y - X\theta\|^2$.
</Remark>

<Example id="ex-gram-schmidt">
**Gram--Schmidt process.** Given linearly independent vectors $\{a_1, \ldots, a_k\}$, Gram--Schmidt produces orthonormal vectors $\{q_1, \ldots, q_k\}$ by iteratively subtracting projections:

$$\tilde{q}_j = a_j - \sum_{i=1}^{j-1} (q_i^\top a_j) q_i, \qquad q_j = \frac{\tilde{q}_j}{\|\tilde{q}_j\|}$$

This is the foundation of QR decomposition ($A = QR$), which is used for solving linear systems, eigenvalue computation, and orthogonalizing weight matrices.
</Example>

## Linear Independence and Basis

<Definition id="def-linear-independence" name="Linear Independence">
Vectors $\{v_1, \dots, v_k\}$ are **linearly independent** if $\sum_{i=1}^k c_i v_i = 0$ implies $c_1 = c_2 = \cdots = c_k = 0$. Equivalently, no vector in the set can be written as a linear combination of the others.

A **basis** for a vector space $V$ is a maximal linearly independent set that spans $V$. Every vector in $V$ can be uniquely written as a linear combination of basis vectors. The number of vectors in any basis is the **dimension** $\dim(V)$.
</Definition>

<Remark id="rmk-rank-dimension">
The **rank** of a matrix $A \in \mathbb{R}^{m \times n}$ equals the dimension of its column space (equivalently, its row space). Key facts:

- $\text{rank}(A) \leq \min(m, n)$
- $A$ is **full rank** iff $\text{rank}(A) = \min(m, n)$
- For square matrices: $A$ is invertible $\iff$ $A$ is full rank $\iff$ $\det(A) \neq 0$
- **Rank-nullity theorem:** $\text{rank}(A) + \text{nullity}(A) = n$ where $\text{nullity}(A) = \dim(\ker(A))$
</Remark>

<Remark id="rmk-lora-rank">
The rank of a weight matrix $W \in \mathbb{R}^{m \times n}$ tells you the effective dimensionality of the transformation. LoRA [@hu2022lora] exploits the empirical observation that fine-tuning weight updates $\Delta W$ have low intrinsic rank: a rank-$r$ factorization $\Delta W = BA$ with $r \ll \min(m,n)$ captures most of the adaptation signal, reducing trainable parameters from $mn$ to $(m+n)r$.
</Remark>

## The Four Fundamental Subspaces

<Definition id="def-four-subspaces" name="The Four Fundamental Subspaces">
For $A \in \mathbb{R}^{m \times n}$ with rank $r$:

1. **Column space** $\text{col}(A) \subseteq \mathbb{R}^m$: dimension $r$. The range of $A$: $\{Ax : x \in \mathbb{R}^n\}$
2. **Row space** $\text{row}(A) = \text{col}(A^\top) \subseteq \mathbb{R}^n$: dimension $r$
3. **Null space** $\ker(A) \subseteq \mathbb{R}^n$: dimension $n - r$. Solutions to $Ax = 0$
4. **Left null space** $\ker(A^\top) \subseteq \mathbb{R}^m$: dimension $m - r$

These subspaces satisfy: $\text{col}(A) \perp \ker(A^\top)$ and $\text{row}(A) \perp \ker(A)$. Together they partition $\mathbb{R}^m$ and $\mathbb{R}^n$ into orthogonal complements.
</Definition>

<Remark id="rmk-four-subspaces-ml">
In ML, these subspaces appear naturally:
- The **column space** of $X$ contains all achievable predictions $\hat{y} = X\theta$.
- The **null space** of $X$ contains parameter directions that do not change the prediction: if $\theta_1 - \theta_2 \in \ker(X)$, then $X\theta_1 = X\theta_2$. Overparameterized models ($n > m$) have non-trivial null spaces, leading to infinitely many solutions with the same training loss.
- L2 regularization selects the **minimum norm** solution from this family: $\theta^* = \arg\min_{\theta: X\theta = y} \|\theta\|$.
</Remark>

## Notation Summary

<Table id="tab-notation-vectors" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $\mathbb{R}^n$ | $n$-dimensional real vector space |
| $x^\top y$ | Dot product (inner product) |
| $\langle x, y \rangle$ | General inner product |
| $\|x\|_p$ | $L_p$ norm |
| $\|A\|_F$ | Frobenius norm |
| $\delta_{ij}$ | Kronecker delta: $1$ if $i=j$, $0$ otherwise |
| $\text{proj}_a(b)$ | Projection of $b$ onto $a$ |
| $P$ | Projection matrix (idempotent: $P^2 = P$) |
| $\text{col}(A)$ | Column space of $A$ |
| $\ker(A)$ | Null space (kernel) of $A$ |
| $\text{rank}(A)$ | Rank of $A$ |
| $\dim(V)$ | Dimension of vector space $V$ |

</Table>
