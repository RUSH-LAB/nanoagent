---
sidebar_position: 4
---

# SVD and PCA

## Singular Value Decomposition

Every matrix $A \in \mathbb{R}^{m \times n}$ (not necessarily square) can be factored as:

$$
A = U \Sigma V^\top
$$

where $U \in \mathbb{R}^{m \times m}$ and $V \in \mathbb{R}^{n \times n}$ are orthogonal matrices, and $\Sigma \in \mathbb{R}^{m \times n}$ is diagonal with non-negative entries $\sigma_1 \geq \sigma_2 \geq \cdots \geq \sigma_r > 0$ called **singular values** ($r = \text{rank}(A)$).

The columns of $U$ are **left singular vectors** (eigenvectors of $AA^\top$), and the columns of $V$ are **right singular vectors** (eigenvectors of $A^\top A$). The singular values satisfy $\sigma_i = \sqrt{\lambda_i(A^\top A)}$.

**Key insight:** SVD reveals the geometry of any linear transformation. $V^\top$ rotates, $\Sigma$ scales along principal axes, and $U$ rotates again. Every linear map is a rotation-scale-rotation.

## Low-Rank Approximation

The **truncated SVD** (Eckart-Young theorem) gives the best rank-$k$ approximation:

$$
A_k = U_k \Sigma_k V_k^\top = \sum_{i=1}^{k} \sigma_i u_i v_i^\top
$$

where $U_k, V_k$ are the first $k$ columns and $\Sigma_k$ is the top-left $k \times k$ block. This minimizes the Frobenius and spectral norms of the error:

$$
\|A - A_k\|_F = \sqrt{\sum_{i=k+1}^{r} \sigma_i^2}, \quad \|A - A_k\|_2 = \sigma_{k+1}
$$

**Key insight:** If singular values decay rapidly, a low-rank approximation captures most of the information. This is the mathematical foundation for LoRA: instead of storing $W \in \mathbb{R}^{d \times d}$, store $B \in \mathbb{R}^{d \times r}$ and $A \in \mathbb{R}^{r \times d}$ with $r \ll d$.

## PCA via SVD

**Principal Component Analysis** finds the directions of maximum variance in a dataset $X \in \mathbb{R}^{m \times n}$ (centered: zero mean).

1. Compute the SVD of the centered data: $X = U \Sigma V^\top$
2. The principal components are the columns of $V$ (right singular vectors)
3. The variance explained by component $i$ is $\sigma_i^2 / (m - 1)$
4. Project data onto $k$ components: $Z = X V_k \in \mathbb{R}^{m \times k}$

Equivalently, PCA eigendecomposes the covariance matrix $C = \frac{1}{m-1}X^\top X = V \frac{\Sigma^2}{m-1} V^\top$. The eigenvectors of $C$ are the right singular vectors of $X$.

**Explained variance ratio** for $k$ components:

$$
\text{EVR}(k) = \frac{\sum_{i=1}^{k} \sigma_i^2}{\sum_{i=1}^{r} \sigma_i^2}
$$

## Connections to ML

| Application | How SVD/PCA is used |
|-------------|---------------------|
| Dimensionality reduction | Project features onto top-$k$ PCs |
| Data visualization | Project to 2D/3D for plotting |
| Noise reduction | Discard small singular values |
| LoRA | Fine-tune with low-rank weight updates $\Delta W = BA$ |
| Recommender systems | Matrix factorization $R \approx U \Sigma V^\top$ |
| Word embeddings | SVD of co-occurrence matrix (GloVe-like) |
| Compression | Store $U_k \Sigma_k V_k^\top$ instead of full matrix |

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $U$ | Left singular vectors (columns are orthonormal) |
| $\Sigma$ | Diagonal matrix of singular values |
| $V$ | Right singular vectors (columns are orthonormal) |
| $\sigma_i$ | $i$-th singular value ($\sigma_1 \geq \sigma_2 \geq \cdots$) |
| $r$ | Rank of the matrix |
| $k$ | Number of retained components |
| $A_k$ | Best rank-$k$ approximation |
| EVR | Explained variance ratio |
