---
sidebar_position: 1
---

# Vectors and Matrices

## Vector Spaces

A **vector space** $V$ over $\mathbb{R}$ is a set equipped with addition and scalar multiplication satisfying closure, associativity, commutativity, and distributivity. The standard example is $\mathbb{R}^n$ -- the space of $n$-tuples of real numbers.

In ML, a data point is a vector $x \in \mathbb{R}^n$ where $n$ is the number of features. A dataset of $m$ points is a matrix $X \in \mathbb{R}^{m \times n}$.

## Dot Product and Inner Products

The **dot product** of two vectors $x, y \in \mathbb{R}^n$ is:

$$
x \cdot y = x^\top y = \sum_{i=1}^{n} x_i y_i = \|x\| \|y\| \cos \theta
$$

where $\theta$ is the angle between them. An **inner product** $\langle \cdot, \cdot \rangle$ generalizes this to any bilinear, symmetric, positive-definite function.

**Key insight:** The dot product measures similarity. In ML, cosine similarity $\frac{x^\top y}{\|x\|\|y\|}$ is used to compare embeddings, attention scores are dot products between queries and keys, and kernel methods replace dot products with kernel functions.

## Norms

A **norm** $\|\cdot\|$ measures vector magnitude. Common norms:

| Norm | Formula | Use in ML |
|------|---------|-----------|
| $L_1$ (Manhattan) | $\|x\|_1 = \sum_i |x_i|$ | Lasso regularization, sparsity |
| $L_2$ (Euclidean) | $\|x\|_2 = \sqrt{\sum_i x_i^2}$ | Ridge regularization, distance |
| $L_\infty$ (max) | $\|x\|_\infty = \max_i |x_i|$ | Adversarial robustness |
| Frobenius | $\|A\|_F = \sqrt{\sum_{i,j} a_{ij}^2}$ | Matrix regularization |

The $L_p$ norm is $\|x\|_p = \left(\sum_i |x_i|^p\right)^{1/p}$. As $p \to 0$, the "norm" counts nonzero entries (not a true norm).

## Orthogonality and Projection

Vectors $x$ and $y$ are **orthogonal** if $x^\top y = 0$. A set of vectors $\{v_1, \dots, v_k\}$ is **orthonormal** if $v_i^\top v_j = \delta_{ij}$.

The **projection** of $b$ onto $a$ is:

$$
\text{proj}_a(b) = \frac{a^\top b}{a^\top a} a
$$

More generally, the projection onto a subspace spanned by columns of $A$ (with orthonormal columns) is:

$$
\text{proj}(b) = A A^\top b
$$

If $A$ does not have orthonormal columns, the projection matrix is $A(A^\top A)^{-1}A^\top$.

**Key insight:** The normal equation for linear regression $\hat{\theta} = (X^\top X)^{-1} X^\top y$ computes the projection of $y$ onto the column space of $X$. The predicted values $\hat{y} = X\hat{\theta}$ are the closest point to $y$ in the span of the features.

## Linear Independence and Basis

Vectors $\{v_1, \dots, v_k\}$ are **linearly independent** if no $v_i$ can be written as a linear combination of the others. A **basis** is a maximal linearly independent set that spans the space. Every vector in $\mathbb{R}^n$ can be uniquely written as a linear combination of $n$ basis vectors.

**Key insight:** The rank of a weight matrix $W \in \mathbb{R}^{m \times n}$ tells you the effective dimensionality of the transformation. Low-rank weight matrices (as in LoRA) can approximate full-rank transformations with far fewer parameters.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $\mathbb{R}^n$ | $n$-dimensional real vector space |
| $x^\top y$ | Dot product (inner product) |
| $\|x\|_p$ | $L_p$ norm |
| $\|A\|_F$ | Frobenius norm |
| $\delta_{ij}$ | Kronecker delta (1 if $i=j$, else 0) |
| $\text{proj}_a(b)$ | Projection of $b$ onto $a$ |
| $\text{span}$ | Set of all linear combinations |
