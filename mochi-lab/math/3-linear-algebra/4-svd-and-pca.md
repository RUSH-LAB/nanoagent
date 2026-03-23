---
sidebar_position: 4
---

# SVD and PCA

The Singular Value Decomposition (SVD) is arguably the most important factorization in all of applied mathematics. It generalizes eigendecomposition to rectangular matrices, provides the optimal low-rank approximation to any matrix, and is the mathematical engine behind PCA, latent semantic analysis, recommender systems, and LoRA. Every data scientist who has reduced dimensionality, every engineer who has compressed a model, and every researcher who has analyzed a weight matrix has used the SVD -- whether they knew it or not.

## Singular Value Decomposition

<Theorem id="thm-svd" name="Singular Value Decomposition">
**Every** matrix $A \in \mathbb{R}^{m \times n}$ (not necessarily square) can be factored as:

<Equation id="eq-svd">

$$A = U \Sigma V^\top$$

</Equation>

where:
- $U \in \mathbb{R}^{m \times m}$ is orthogonal ($U^\top U = I$), its columns are the **left singular vectors**
- $V \in \mathbb{R}^{n \times n}$ is orthogonal ($V^\top V = I$), its columns are the **right singular vectors**
- $\Sigma \in \mathbb{R}^{m \times n}$ is diagonal with non-negative entries $\sigma_1 \geq \sigma_2 \geq \cdots \geq \sigma_r > 0$ called **singular values**, where $r = \text{rank}(A)$

This decomposition always exists and the singular values are unique (though $U$ and $V$ may not be unique when singular values are repeated).
</Theorem>

**Connection to eigendecomposition.** The singular values and vectors are derived from the eigendecompositions of $A^\top A$ and $AA^\top$:

- $A^\top A = V \Sigma^\top \Sigma V^\top$: the right singular vectors $V$ are eigenvectors of $A^\top A$, and $\sigma_i^2$ are its eigenvalues
- $AA^\top = U \Sigma \Sigma^\top U^\top$: the left singular vectors $U$ are eigenvectors of $AA^\top$

<Remark id="rmk-svd-geometry">
**Geometric interpretation.** Every linear transformation $x \mapsto Ax$ is equivalent to three steps:

1. **Rotate** (by $V^\top$): align with the principal axes of the transformation
2. **Scale** (by $\Sigma$): stretch or compress along each axis by $\sigma_i$
3. **Rotate** (by $U$): rotate the scaled result into the output space

This reveals the deep structure: every linear map is a rotation--scale--rotation. The singular values tell you *how much* each dimension is stretched or compressed.
</Remark>

<Example id="ex-svd-image">
**SVD of an image.** A grayscale image of size $m \times n$ can be decomposed via SVD. The rank-$k$ approximation $A_k = \sum_{i=1}^k \sigma_i u_i v_i^\top$ uses only $k(m + n + 1)$ numbers instead of $mn$. For a $1000 \times 1000$ image with $k = 50$: storage drops from $10^6$ to $\sim 10^5$ (10x compression) while retaining $\sum_{i=1}^{50}\sigma_i^2 / \sum_i \sigma_i^2$ of the image's energy.
</Example>

### Compact and Truncated Forms

<Table id="tab-svd-forms" caption="Three forms of the SVD.">

| Form | Dimensions | Storage | When to use |
|------|-----------|---------|-------------|
| **Full SVD** | $U \in \mathbb{R}^{m \times m}$, $\Sigma \in \mathbb{R}^{m \times n}$, $V \in \mathbb{R}^{n \times n}$ | $m^2 + mn + n^2$ | Theoretical analysis |
| **Compact SVD** | $U_r \in \mathbb{R}^{m \times r}$, $\Sigma_r \in \mathbb{R}^{r \times r}$, $V_r \in \mathbb{R}^{n \times r}$ | $(m+n)r + r$ | When $r \ll \min(m,n)$ |
| **Truncated SVD** | $U_k \in \mathbb{R}^{m \times k}$, $\Sigma_k \in \mathbb{R}^{k \times k}$, $V_k \in \mathbb{R}^{n \times k}$ | $(m+n)k + k$ | Dimensionality reduction |

</Table>

## Low-Rank Approximation

<Theorem id="thm-eckart-young" name="Eckart--Young--Mirsky Theorem">
The truncated SVD $A_k = U_k \Sigma_k V_k^\top = \sum_{i=1}^{k} \sigma_i u_i v_i^\top$ is the **best rank-$k$ approximation** to $A$ in both the Frobenius and spectral norms:

<Equation id="eq-eckart-young-frobenius">

$$A_k = \arg\min_{\text{rank}(B) \leq k} \|A - B\|_F, \qquad \|A - A_k\|_F = \sqrt{\sum_{i=k+1}^{r} \sigma_i^2}$$

</Equation>

<Equation id="eq-eckart-young-spectral">

$$A_k = \arg\min_{\text{rank}(B) \leq k} \|A - B\|_2, \qquad \|A - A_k\|_2 = \sigma_{k+1}$$

</Equation>

No other rank-$k$ matrix achieves a smaller error in either norm.
</Theorem>

**Proof sketch (Frobenius).** Write $A = \sum_{i=1}^r \sigma_i u_i v_i^\top$. The squared Frobenius norm is $\|A\|_F^2 = \sum_i \sigma_i^2$ (since the $u_i v_i^\top$ are orthonormal in the Frobenius inner product). The error of *any* rank-$k$ approximation satisfies $\|A - B\|_F^2 \geq \sum_{i=k+1}^r \sigma_i^2$ (by the min-max characterization of singular values). The truncated SVD achieves this bound with equality. $\square$

<Remark id="rmk-svd-compression-ratio">
**When is low-rank approximation effective?** The approximation quality depends on the **singular value spectrum**:

- **Rapid decay** ($\sigma_i \propto i^{-\alpha}$ for $\alpha > 1$): a small $k$ captures most of the energy. Natural images, text embeddings, and weight matrices often exhibit this.
- **Slow decay** ($\sigma_i \approx \sigma_1$ for many $i$): the matrix is "effectively full rank" and low-rank approximation loses substantial information. Random matrices have this property.
- **Energy fraction** $\text{EVR}(k) = \sum_{i=1}^k \sigma_i^2 / \sum_i \sigma_i^2$ quantifies how well $A_k$ approximates $A$.
</Remark>

<Remark id="rmk-lora-svd">
**LoRA as approximate truncated SVD** [@hu2022lora]. LoRA parameterizes the weight update as $\Delta W = BA$ where $B \in \mathbb{R}^{d \times r}$, $A \in \mathbb{R}^{r \times d}$. This constrains $\Delta W$ to have rank at most $r$. Unlike truncated SVD, LoRA does not require computing the SVD of the full weight matrix -- it learns the best rank-$r$ update directly via gradient descent. The Eckart--Young theorem guarantees that if the true optimal $\Delta W^*$ has rapidly decaying singular values, a small $r$ suffices.
</Remark>

## Principal Component Analysis

<Definition id="def-pca" name="Principal Component Analysis">
**PCA** finds the directions of maximum variance in a dataset $X \in \mathbb{R}^{m \times n}$ (assumed centered: $\bar{x} = 0$).

**Algorithm (via SVD):**
1. Center the data: $X \leftarrow X - \mathbf{1}\bar{x}^\top$
2. Compute the SVD: $X = U \Sigma V^\top$
3. The **principal components** are the columns of $V$ (right singular vectors)
4. The **variance explained** by component $i$ is $\sigma_i^2 / (m - 1)$
5. **Project** data onto $k$ components: $Z = X V_k \in \mathbb{R}^{m \times k}$

Equivalently, PCA eigendecomposes the sample covariance matrix:
$$C = \frac{1}{m-1}X^\top X = V \frac{\Sigma^2}{m-1} V^\top$$
The eigenvectors of $C$ are the right singular vectors of $X$, and the eigenvalues of $C$ are $\sigma_i^2/(m-1)$.
</Definition>

<Remark id="rmk-pca-optimality">
**PCA is optimal in two equivalent senses:**

1. **Maximum variance:** The first $k$ principal components capture more variance than any other $k$-dimensional linear projection (by Eckart--Young).
2. **Minimum reconstruction error:** The projection $Z = XV_k$ followed by reconstruction $\hat{X} = ZV_k^\top$ minimizes $\|X - \hat{X}\|_F^2$ over all rank-$k$ linear projections.

These two views are equivalent because the total variance $\text{tr}(C) = \sum_i \sigma_i^2/(m-1)$ is fixed, so maximizing captured variance is the same as minimizing lost variance (reconstruction error).
</Remark>

**Explained variance ratio** for $k$ components:

<Equation id="eq-evr">

$$\text{EVR}(k) = \frac{\sum_{i=1}^{k} \sigma_i^2}{\sum_{i=1}^{r} \sigma_i^2}$$

</Equation>

A common heuristic is to choose $k$ such that $\text{EVR}(k) \geq 0.95$ (95% of the variance).

<Example id="ex-pca-mnist">
**PCA on MNIST.** The MNIST dataset has 784 pixel features per image ($28 \times 28$). PCA reveals that $\sim 95\%$ of the variance is captured by the first $\sim 150$ components, meaning the data lives in a roughly 150-dimensional subspace of $\mathbb{R}^{784}$. The first two principal components often separate different digits visually, though the separation is imperfect (nonlinear methods like t-SNE or UMAP do better for visualization).
</Example>

<Example id="ex-pca-computation">
**PCA computation step by step.** Given data matrix $X \in \mathbb{R}^{4 \times 3}$ (4 samples, 3 features):

1. **Center:** $\bar{x} = \frac{1}{4}\sum_i x_i$, then $\tilde{X} = X - \mathbf{1}\bar{x}^\top$
2. **Covariance:** $C = \frac{1}{3}\tilde{X}^\top \tilde{X} \in \mathbb{R}^{3 \times 3}$
3. **Eigendecompose:** $C = V \Lambda V^\top$ with $\lambda_1 \geq \lambda_2 \geq \lambda_3 \geq 0$
4. **Project to $k=2$:** $Z = \tilde{X} V_{:,1:2} \in \mathbb{R}^{4 \times 2}$
5. **Reconstruct:** $\hat{X} = Z V_{:,1:2}^\top + \mathbf{1}\bar{x}^\top$
6. **Error:** $\|\tilde{X} - Z V_{:,1:2}^\top\|_F^2 = \lambda_3$ (the discarded variance)

In practice, use `torch.pca_lowrank(X, q=k)` or `sklearn.decomposition.PCA(n_components=k)`, which compute the truncated SVD directly without forming the covariance matrix (more numerically stable and efficient for $n \gg d$).
</Example>

### PCA Limitations and Extensions

<Table id="tab-pca-extensions" caption="PCA limitations and nonlinear alternatives.">

| Limitation of PCA | Alternative | Key Idea |
|-------------------|-------------|----------|
| Only captures linear structure | **Kernel PCA** | Apply PCA in kernel-induced feature space |
| Sensitive to outliers | **Robust PCA** | Decompose $M = L + S$ (low-rank + sparse) |
| Assumes Gaussian-like data | **ICA** | Find statistically independent (not just uncorrelated) components |
| Variance $\neq$ information | **Autoencoders** | Learn nonlinear low-dimensional representations |
| Global structure only | **t-SNE, UMAP** | Preserve local neighborhood structure for visualization |

</Table>

## Applications of SVD in ML

<Table id="tab-svd-applications" caption="Applications of SVD and PCA in machine learning.">

| Application | How SVD/PCA Is Used | Computational Note |
|-------------|---------------------|-------------------|
| **Dimensionality reduction** | Project features onto top-$k$ PCs | Randomized SVD for large matrices |
| **Data visualization** | Project to 2D/3D via PCA | Often followed by t-SNE/UMAP |
| **Noise reduction** | Discard small singular values (soft/hard thresholding) | Optimal threshold: $\sigma > \sigma_{\text{med}} \sqrt{2\log n}$ |
| **LoRA** | Low-rank weight updates $\Delta W = BA$ | Rank $r = 4$--$64$ typical |
| **Recommender systems** | Matrix factorization $R \approx U \Sigma V^\top$ | Netflix Prize approach |
| **Word embeddings** | SVD of PMI matrix | GloVe is equivalent to weighted SVD |
| **Image compression** | Truncated SVD per channel | Lossy compression with controllable quality |
| **Pseudoinverse** | $A^+ = V \Sigma^+ U^\top$ | Numerically stable least squares |
| **Spectral clustering** | Eigenvectors of graph Laplacian | SVD of normalized adjacency |
| **Whitening** | $X_w = X V \Sigma^{-1}$ | Decorrelate and normalize features |

</Table>

<Remark id="rmk-randomized-svd">
**Randomized SVD.** For large matrices ($m, n \gg k$), computing the full SVD is $O(mn \min(m,n))$, which is prohibitive. Randomized algorithms [@halko2011finding] compute an approximate rank-$k$ SVD in $O(mnk)$ time:

1. Generate a random matrix $\Omega \in \mathbb{R}^{n \times (k+p)}$ (with oversampling $p \approx 5$--$10$)
2. Form $Y = A\Omega \in \mathbb{R}^{m \times (k+p)}$ (one pass over $A$)
3. Compute QR: $Y = QR$
4. Form $B = Q^\top A \in \mathbb{R}^{(k+p) \times n}$ (second pass over $A$)
5. Compute SVD of the small matrix $B = \hat{U}\Sigma V^\top$
6. Set $U = Q\hat{U}$

This is implemented in `sklearn.decomposition.TruncatedSVD` and `torch.svd_lowrank`.
</Remark>

## Notation Summary

<Table id="tab-notation-svd" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $U$ | Left singular vectors (orthonormal columns) |
| $\Sigma$ | Diagonal matrix of singular values |
| $V$ | Right singular vectors (orthonormal columns) |
| $\sigma_i$ | $i$-th singular value ($\sigma_1 \geq \sigma_2 \geq \cdots$) |
| $u_i, v_i$ | $i$-th left/right singular vector |
| $r$ | Rank of the matrix |
| $k$ | Number of retained components |
| $A_k$ | Best rank-$k$ approximation |
| $C$ | Sample covariance matrix |
| EVR | Explained variance ratio |
| $A^+$ | Moore--Penrose pseudoinverse |

</Table>
