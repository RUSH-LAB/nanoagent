---
sidebar_position: 3
---

# Graph Neural Networks

Graph Neural Networks (GNNs) extend deep learning to data with irregular, non-Euclidean structure: social networks, molecular graphs, knowledge graphs, point clouds, and meshes. Unlike images (regular grids) or text (sequences), graphs have variable-size neighborhoods and no canonical ordering of nodes. This chapter covers the mathematical foundations: graph theory basics, spectral methods, the message passing framework, and key architectures.

## Graphs and Adjacency

<Definition id="def-graph" name="Graph">
A **graph** $G = (V, E)$ consists of:
- **Vertices** (nodes) $V = \{1, 2, \ldots, n\}$ with feature vectors $x_i \in \mathbb{R}^{d_0}$
- **Edges** $E \subseteq V \times V$ with optional features $e_{ij} \in \mathbb{R}^{d_e}$

The **adjacency matrix** $A \in \{0,1\}^{n \times n}$ has $A_{ij} = 1$ if $(i,j) \in E$ (or $A_{ij} = w_{ij}$ for weighted graphs). The **degree matrix** $D = \text{diag}(d_1, \dots, d_n)$ where $d_i = \sum_j A_{ij}$. The **neighborhood** of node $i$ is $\mathcal{N}(i) = \{j : (i,j) \in E\}$.
</Definition>

<Table id="tab-graph-types" caption="Types of graphs in ML applications.">

| Graph Type | Properties | Example |
|-----------|-----------|---------|
| Undirected | $A = A^\top$ | Social networks, molecules |
| Directed | $A \neq A^\top$ | Citation networks, web graphs |
| Weighted | $A_{ij} \in \mathbb{R}$ | Similarity graphs, distance networks |
| Bipartite | $V = V_1 \cup V_2$, edges only between $V_1, V_2$ | User-item interactions |
| Heterogeneous | Multiple node/edge types | Knowledge graphs |
| Dynamic | Edges/nodes change over time | Temporal interaction networks |
| Hypergraph | Edges connect $> 2$ nodes | Co-authorship, group interactions |

</Table>

## Graph Laplacian

<Definition id="def-graph-laplacian" name="Graph Laplacian">
The **unnormalized Laplacian** is $L = D - A$. Key properties:

- **Symmetric** and **positive semi-definite** ($L \succeq 0$)
- **Null space:** $L \mathbf{1} = 0$, so the constant vector is an eigenvector with eigenvalue $0$
- **Connected components:** The number of zero eigenvalues equals the number of connected components of $G$
- **Quadratic form:** $x^\top L x = \frac{1}{2}\sum_{(i,j) \in E} w_{ij}(x_i - x_j)^2$

The **symmetric normalized Laplacian** is $\hat{L} = I - D^{-1/2} A D^{-1/2}$, with eigenvalues in $[0, 2]$.

The **random walk Laplacian** is $L_{\text{rw}} = I - D^{-1}A$, whose eigenvectors are related to the stationary distribution of a random walk on $G$.
</Definition>

<Example id="ex-triangle-laplacian">
**Laplacian of a triangle graph.** Take the complete graph on three nodes $K_3$ (every pair connected). The adjacency, degree, and Laplacian matrices are

$$
A = \begin{pmatrix} 0 & 1 & 1 \\ 1 & 0 & 1 \\ 1 & 1 & 0 \end{pmatrix}, \quad
D = \begin{pmatrix} 2 & 0 & 0 \\ 0 & 2 & 0 \\ 0 & 0 & 2 \end{pmatrix}, \quad
L = D - A = \begin{pmatrix} 2 & -1 & -1 \\ -1 & 2 & -1 \\ -1 & -1 & 2 \end{pmatrix}.
$$

To get the eigenvalues, note that $A = J - I$ where $J$ is the all-ones matrix, so $L = 2I - (J - I) = 3I - J$. The matrix $J$ has eigenvalues $\{3, 0, 0\}$ (eigenvalue $3$ for $\mathbf{1}$, eigenvalue $0$ for the two-dimensional orthogonal complement). Therefore $L = 3I - J$ has eigenvalues

$$\lambda_0 = 3 - 3 = 0, \qquad \lambda_1 = \lambda_2 = 3 - 0 = 3.$$

The single zero eigenvalue (with eigenvector $\mathbf{1}$) confirms one connected component, matching the properties above. Checking the Dirichlet energy on $x = (1, 0, 0)^\top$: $x^\top L x = 2$, which equals $\frac{1}{2}\sum_{(i,j)\in E}(x_i - x_j)^2 = \frac{1}{2}\big[(1-0)^2 + (1-0)^2 + (0-0)^2\big] \cdot 2 = 2$ (each of the two edges touching node $1$ contributes $1$, counted in both directions). The symmetric normalized operator is $D^{-1/2}AD^{-1/2} = \frac{1}{2}A$, with eigenvalues $\{1, -\tfrac12, -\tfrac12\}$, so the normalized Laplacian $\hat{L} = I - \frac{1}{2}A$ has eigenvalues $\{0, \tfrac32, \tfrac32\} \subset [0, 2]$, as guaranteed.
</Example>

<Remark id="rmk-laplacian-smoothness">
**The Laplacian measures signal smoothness.** The quadratic form $x^\top L x = \frac{1}{2}\sum_{(i,j)} (x_i - x_j)^2$ is the **Dirichlet energy**: it is small when neighboring nodes have similar values and large when they differ. This is the graph analogue of $\int |\nabla f|^2 dx$ for continuous functions.

This connects directly to GNNs: message passing averages neighboring features, which is equivalent to applying a low-pass filter on the graph. The eigenvectors of $L$ with small eigenvalues correspond to "smooth" signals (low-frequency components), while large eigenvalues correspond to "oscillating" signals (high-frequency).
</Remark>

<Remark id="rmk-spectral-clustering">
**Spectral clustering.** The eigenvectors of $L$ corresponding to the smallest non-zero eigenvalues (the **Fiedler vectors**) approximately solve the graph partitioning problem. Spectral clustering computes $k$ such eigenvectors, treats them as node embeddings in $\mathbb{R}^k$, and runs $k$-means. This is equivalent to relaxing the discrete min-cut problem to a continuous optimization: $\min_{X \in \mathbb{R}^{n \times k}} \text{tr}(X^\top L X)$ subject to $X^\top X = I$.
</Remark>

## Spectral Graph Theory

The eigendecomposition $L = U \Lambda U^\top$ (where $\Lambda = \text{diag}(\lambda_0, \ldots, \lambda_{n-1})$ with $0 = \lambda_0 \leq \lambda_1 \leq \cdots$) defines the **graph Fourier transform**:

<Equation id="eq-graph-fourier">

$$\hat{x} = U^\top x \quad \text{(forward)}, \quad x = U \hat{x} \quad \text{(inverse)}$$

</Equation>

The coefficient $\hat{x}_k = u_k^\top x$ measures how much the signal $x$ "oscillates" at frequency $\lambda_k$.

<Definition id="def-spectral-conv" name="Spectral Graph Convolution">
**Spectral convolution** on a graph applies a filter $g_\theta$ in the frequency domain:

<Equation id="eq-spectral-conv">

$$x *_G g_\theta = U \, g_\theta(\Lambda) \, U^\top x = U \, \text{diag}(g_\theta(\lambda_0), \ldots, g_\theta(\lambda_{n-1})) \, U^\top x$$

</Equation>

This is the graph analogue of the convolution theorem: convolution in the spatial domain equals multiplication in the frequency domain.
</Definition>

<Remark id="rmk-spectral-to-spatial">
**From spectral to spatial methods.** Spectral convolution has two problems: (1) computing the eigendecomposition is $O(n^3)$, and (2) the filter $g_\theta(\Lambda)$ has $n$ free parameters (one per eigenvalue), so it does not transfer across graphs.

**ChebNet** [@defferrard2016convolutional] approximates $g_\theta(\Lambda)$ with a $K$-th order Chebyshev polynomial: $g_\theta(\Lambda) \approx \sum_{k=0}^K \theta_k T_k(\tilde{\Lambda})$ where $\tilde{\Lambda} = 2\Lambda/\lambda_{\max} - I$. Since $T_k(L)$ can be computed via the recurrence $T_k(L)x = 2L \cdot T_{k-1}(L)x - T_{k-2}(L)x$, this requires only matrix-vector products with $L$ (no eigendecomposition). The result is a $K$-hop localized filter with $K+1$ parameters.

**GCN** [@kipf2017gcn] uses $K = 1$ with a single parameter, giving the first-order approximation that leads to the spatial message passing formula.
</Remark>

## Message Passing Framework

<Definition id="def-message-passing" name="Message Passing Neural Network">
Most GNNs follow the **message passing** paradigm [@gilmer2017neural]. At each layer $l$, each node $i$ updates its representation by:

1. **Message computation:** Compute a message from each neighbor $j$:

$$m_{j \to i}^{(l)} = \phi^{(l)}(h_i^{(l)}, h_j^{(l)}, e_{ij})$$

2. **Aggregation:** Combine messages using a permutation-invariant function:

<Equation id="eq-message-passing">

$$m_i^{(l)} = \bigoplus_{j \in \mathcal{N}(i)} m_{j \to i}^{(l)}$$

</Equation>

3. **Update:** Combine the aggregated message with the node's own representation:

$$h_i^{(l+1)} = \psi^{(l)}(h_i^{(l)}, m_i^{(l)})$$

where $\bigoplus$ is a permutation-invariant aggregation (sum, mean, max), $\phi$ is the message function, and $\psi$ is the update function.
</Definition>

<Remark id="rmk-aggregation-choice">
**Aggregation function matters.** The choice of $\bigoplus$ affects the expressive power:

| Aggregation | Formula | Properties | Issue |
|------------|---------|-----------|-------|
| **Sum** | $\sum_j m_j$ | Injective for multisets (most expressive) | Sensitive to degree |
| **Mean** | $\frac{1}{|\mathcal{N}|}\sum_j m_j$ | Degree-invariant | Cannot distinguish different-size neighborhoods with same average |
| **Max** | $\max_j m_j$ | Robust to outliers | Loses multiplicity information |
| **Attention-weighted** | $\sum_j \alpha_{ij} m_j$ | Data-dependent, adaptive | More parameters, harder to train |

Xu et al. [@xu2019how] proved that sum aggregation is maximally expressive among these choices, as it can distinguish different multisets. This motivates the GIN (Graph Isomorphism Network) architecture.
</Remark>

<Remark id="rmk-mpnn-as-matrix">
**Message passing as matrix operation.** For GCN-style aggregation, the layer update is:

$$H^{(l+1)} = \sigma(\hat{A} H^{(l)} W^{(l)})$$

where $\hat{A} = \tilde{D}^{-1/2}\tilde{A}\tilde{D}^{-1/2}$ is the normalized adjacency with self-loops. This is a sparse matrix multiplication followed by a dense linear transform and nonlinearity, exactly the form that GPUs handle efficiently. The sparsity of $A$ (most real graphs are sparse: $|E| = O(n)$) means the computation per layer is $O(|E| \cdot d + n \cdot d^2)$ rather than $O(n^2 d)$.
</Remark>

## GCN and GAT

<Definition id="def-gcn" name="Graph Convolutional Network">
**Graph Convolutional Network (GCN)** [@kipf2017gcn] uses normalized adjacency for aggregation:

<Equation id="eq-gcn">

$$H^{(l+1)} = \sigma\left(\tilde{D}^{-1/2} \tilde{A} \tilde{D}^{-1/2} H^{(l)} W^{(l)}\right)$$

</Equation>

where $\tilde{A} = A + I$ (add self-loops) and $\tilde{D}_{ii} = \sum_j \tilde{A}_{ij}$. The normalization $\tilde{D}^{-1/2}\tilde{A}\tilde{D}^{-1/2}$ is symmetric and ensures that the aggregation is scale-invariant (the spectral radius is bounded by 1).
</Definition>

<Definition id="def-gat" name="Graph Attention Network">
**Graph Attention Network (GAT)** [@velickovic2018gat] replaces fixed normalization with learned attention weights:

<Equation id="eq-gat-attention">

$$\alpha_{ij} = \frac{\exp(\text{LeakyReLU}(a^\top [W h_i \| W h_j]))}{\sum_{k \in \mathcal{N}(i) \cup \{i\}} \exp(\text{LeakyReLU}(a^\top [W h_i \| W h_k]))}$$

</Equation>

$$
h_i^{(l+1)} = \sigma\left(\sum_{j \in \mathcal{N}(i) \cup \{i\}} \alpha_{ij} W h_j^{(l)}\right)
$$

where $a \in \mathbb{R}^{2d'}$ is a learnable attention vector, $W \in \mathbb{R}^{d' \times d}$ is a shared linear transform, and $\|$ denotes concatenation. Multi-head attention extends this: $h_i' = \|_{k=1}^K \sigma(\sum_j \alpha_{ij}^k W^k h_j)$.
</Definition>

<Table id="tab-gnn-comparison" caption="Comparison of GNN architectures.">

| Model | Aggregation | Attention | Complexity per node | Key Property |
|-------|-------------|-----------|-------------------|--------------|
| GCN | Degree-normalized mean | Fixed (by degree) | $O(|\mathcal{N}| \cdot d + d^2)$ | Simple, efficient |
| GAT | Attention-weighted sum | Learned (pairwise) | $O(|\mathcal{N}| \cdot d^2)$ | Adaptive, data-dependent |
| GraphSAGE | Sample + aggregate | Mean/LSTM/pool | $O(k \cdot d^2)$ ($k$ = sample size) | Scalable (fixed neighborhood) |
| GIN | Sum (no normalization) | None | $O(|\mathcal{N}| \cdot d + d^2)$ | Maximally expressive (WL-test) |
| MPNN | General (learnable) | Optional | $O(|\mathcal{N}| \cdot d^2)$ | Most general framework |
| GATv2 [@brody2022how] | Attention-weighted sum | Dynamic (full expressivity) | $O(|\mathcal{N}| \cdot d^2)$ | Fixes GAT's static attention |

</Table>

## Expressiveness: The WL Test

<Definition id="def-wl-test" name="Weisfeiler-Leman Test">
The **1-dimensional Weisfeiler-Leman (1-WL)** graph isomorphism test iteratively refines node colors:

1. Initialize: $c_i^{(0)} = \text{hash}(x_i)$ (based on node features)
2. Update: $c_i^{(l+1)} = \text{hash}(c_i^{(l)}, \{\!\{c_j^{(l)} : j \in \mathcal{N}(i)\}\!\})$
3. Two graphs are declared "possibly isomorphic" if they have the same multiset of final colors

The 1-WL test is a necessary (but not sufficient) condition for graph isomorphism.
</Definition>

<Example id="ex-wl-path">
**One round of 1-WL on a path graph.** Consider the path $P_4$ with nodes $1\!-\!2\!-\!3\!-\!4$ and no node features, so all nodes start with the same color $c^{(0)} = a$. The neighborhoods are $\mathcal{N}(1) = \{2\}$, $\mathcal{N}(2) = \{1,3\}$, $\mathcal{N}(3) = \{2,4\}$, $\mathcal{N}(4) = \{3\}$.

**Round 1.** Each node hashes its own color together with the multiset of neighbor colors:

| Node | $(c^{(0)}, \{\!\{\text{neighbors}\}\!\})$ | New color |
|------|------------------------------------------|-----------|
| 1 | $(a, \{\!\{a\}\!\})$ | $b$ |
| 2 | $(a, \{\!\{a, a\}\!\})$ | $c$ |
| 3 | $(a, \{\!\{a, a\}\!\})$ | $c$ |
| 4 | $(a, \{\!\{a\}\!\})$ | $b$ |

The degree-$1$ endpoints $\{1, 4\}$ split off from the degree-$2$ interior $\{2, 3\}$: after one round the colors already encode node degree.

**Round 2 (faded guidance).** Now feed the colors $c^{(1)} = (b, c, c, b)$ back in. Work out each node's signature $(c^{(1)}_i, \{\!\{c^{(1)}_j : j \in \mathcal{N}(i)\}\!\})$ yourself; you should find that nodes $1$ and $4$ both get $(b, \{\!\{c\}\!\})$ and nodes $2$ and $3$ both get $(c, \{\!\{b, c\}\!\})$. The induced partition $\{\{1,4\}, \{2,3\}\}$ is identical to round 1, so the coloring has **stabilized**: no further round can refine it. The test cannot tell node $2$ from node $3$, which reflects the genuine automorphism of $P_4$ that swaps the two ends, and is exactly the kind of symmetric pair that no message passing GNN can separate either.
</Example>

<Theorem id="thm-gnn-wl" name="GNN Expressiveness Bound">
**Message passing GNNs are at most as powerful as the 1-WL test** [@xu2019how; @morris2019weisfeiler]. Specifically:

- If two nodes have different 1-WL colors, a sufficiently expressive MPNN can distinguish them.
- If two nodes have the same 1-WL colors, no MPNN can distinguish them (regardless of depth or width).

The **Graph Isomorphism Network (GIN)** achieves the 1-WL upper bound by using sum aggregation and an injective update: $h_i^{(l+1)} = \text{MLP}((1 + \epsilon) \cdot h_i^{(l)} + \sum_{j \in \mathcal{N}(i)} h_j^{(l)})$.
</Theorem>

<Remark id="rmk-beyond-wl">
**Going beyond 1-WL.** The 1-WL test (and thus standard MPNNs) cannot count certain substructures (e.g., triangles, cycles of length $> 3$) or distinguish some non-isomorphic regular graphs. Higher-order methods include:

- **$k$-WL / $k$-FWL:** Operate on $k$-tuples of nodes; $k$-WL for $k \geq 3$ is strictly more powerful
- **Equivariant subgraph GNNs:** Process subgraphs around each node
- **Random features:** Add random node features to break symmetry (probabilistic)
- **Positional encodings:** Use Laplacian eigenvectors or random walk statistics as additional features
- **Graph Transformers:** Full pairwise attention (not restricted to edges) achieves higher expressivity
</Remark>

## Over-Smoothing

<Definition id="def-over-smoothing" name="Over-Smoothing">
**Over-smoothing** occurs when GNN depth increases and node representations converge to a common vector, losing discriminative power. Formally, as $L \to \infty$:

<Equation id="eq-over-smoothing">

$$\lim_{L \to \infty} (\tilde{D}^{-1/2} \tilde{A} \tilde{D}^{-1/2})^L H = \frac{(\tilde{D}^{1/2}\mathbf{1})(\tilde{D}^{1/2}\mathbf{1})^\top}{\|\tilde{D}^{1/2}\mathbf{1}\|^2} H$$

</Equation>

The dominant eigenvector of the symmetric operator $\tilde{D}^{-1/2}\tilde{A}\tilde{D}^{-1/2}$ (eigenvalue $1$) is $u \propto \tilde{D}^{1/2}\mathbf{1}$, so the limit is the rank-one orthogonal projector onto $u$. All node representations collapse onto this single direction (a degree-weighted average of the input features), losing the information that distinguished them. The equivalent statement for the random walk operator $\tilde{D}^{-1}\tilde{A}$ is $\mathbf{1}\pi^\top H$, where $\pi$ is the stationary distribution of the random walk on $G$.
</Definition>

<Remark id="rmk-over-smoothing-analysis">
**Why over-smoothing happens and how to mitigate it.** Each message passing layer applies a low-pass filter (averaging with neighbors). Repeated application exponentially suppresses high-frequency components. The convergence rate depends on the spectral gap $\lambda_1$ of the normalized Laplacian: larger gap means faster convergence (faster over-smoothing).

| Mitigation | Mechanism | Reference |
|-----------|-----------|-----------|
| **Residual connections** | $h^{(l+1)} = h^{(l)} + \text{GNN}(h^{(l)})$ | Analogous to ResNet; preserves input signal |
| **JK (Jumping Knowledge)** | Concatenate or aggregate all layers: $h_i = f(h_i^{(1)}, \ldots, h_i^{(L)})$ | Uses multi-scale features [@xu2018representation] |
| **DropEdge** | Randomly remove edges during training | Reduces effective receptive field |
| **PairNorm** | Normalize representations to maintain distance | Prevents collapse to constant vector |
| **DeeperGCN** | Pre-activation residual + generalized aggregation | Enables training GNNs with 50+ layers |
| **Limit depth** | Use only 2-4 layers | Practical default for most tasks |

In practice, most GNN applications use 2-4 layers. Unlike Transformers (which benefit from 100+ layers), GNNs hit diminishing returns quickly because the receptive field grows exponentially with depth, and over-smoothing degrades representations.
</Remark>

## Graph-Level Prediction

<Definition id="def-graph-pooling" name="Graph Pooling (Readout)">
For graph-level tasks (graph classification, property prediction), node representations must be aggregated into a single graph-level vector:

$$h_G = \text{READOUT}(\{h_i^{(L)} : i \in V\})$$

Common readout functions:
- **Sum:** $h_G = \sum_i h_i$ (most expressive for distinguishing graphs, but size-dependent)
- **Mean:** $h_G = \frac{1}{|V|}\sum_i h_i$ (size-invariant, but less expressive)
- **Set2Set:** Attention-based pooling (learnable, order-invariant)
- **Virtual node:** Add a node connected to all others; its final representation is the graph embedding
</Definition>

## Applications

<Table id="tab-gnn-applications" caption="GNN applications across domains.">

| Domain | Task | Graph Structure | Typical Architecture |
|--------|------|----------------|---------------------|
| Chemistry | Molecular property prediction | Atoms = nodes, bonds = edges | SchNet, DimeNet, GemNet |
| Drug discovery | Drug-target interaction | Molecular + protein graphs | Heterogeneous GNN |
| Social networks | Community detection, link prediction | Users = nodes, connections = edges | GAT, GraphSAGE |
| Recommendation | User-item matching | Bipartite interaction graph | LightGCN, PinSage |
| Computer vision | Scene understanding, point clouds | Object/pixel graphs | DGCNN, PointNet++ |
| Physics simulation | Particle/fluid dynamics | Particles = nodes, interactions = edges | GNS [@sanchez2020learning] |
| Combinatorial optimization | TSP, scheduling | Problem-specific graphs | GNN + reinforcement learning |
| Knowledge graphs | Link prediction, QA | Entity-relation triples | R-GCN, CompGCN |

</Table>

## Notation Summary

<Table id="tab-notation-gnn" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $G = (V, E)$ | Graph with vertices and edges |
| $n = |V|$ | Number of nodes |
| $A$ | Adjacency matrix |
| $D$ | Degree matrix |
| $L = D - A$ | Unnormalized graph Laplacian |
| $\hat{L} = I - D^{-1/2}AD^{-1/2}$ | Normalized Laplacian |
| $\lambda_k, u_k$ | $k$-th eigenvalue/eigenvector of $L$ |
| $\mathcal{N}(i)$ | Neighbors of node $i$ |
| $h_i^{(l)}$ | Node $i$ representation at layer $l$ |
| $\alpha_{ij}$ | Attention coefficient (GAT) |
| $\bigoplus$ | Permutation-invariant aggregation |
| $e_{ij}$ | Edge features |
| WL | Weisfeiler-Leman graph isomorphism test |

</Table>
