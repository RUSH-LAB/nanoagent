---
sidebar_position: 3
---

# Graph Neural Networks

## Graphs and Adjacency

A graph $G = (V, E)$ consists of vertices $V$ and edges $E$. The **adjacency matrix** $A \in \{0,1\}^{n \times n}$ has $A_{ij} = 1$ if $(i,j) \in E$. The **degree matrix** $D = \text{diag}(d_1, \dots, d_n)$ where $d_i = \sum_j A_{ij}$.

## Graph Laplacian

The **unnormalized Laplacian** is $L = D - A$. Key properties:

- Symmetric and positive semi-definite
- $L \mathbf{1} = 0$ (the all-ones vector is an eigenvector with eigenvalue 0)
- Number of zero eigenvalues equals the number of connected components
- Quadratic form: $x^\top L x = \sum_{(i,j) \in E} (x_i - x_j)^2$

The **normalized Laplacian** $\hat{L} = I - D^{-1/2} A D^{-1/2}$ has eigenvalues in $[0, 2]$.

**Key insight:** The quadratic form $x^\top L x$ measures the "smoothness" of a signal $x$ on the graph. Small values mean neighboring nodes have similar values. This connects to GNNs: message passing produces smooth node representations.

## Spectral Graph Theory

The eigendecomposition $L = U \Lambda U^\top$ defines the **graph Fourier transform**:

$$
\hat{x} = U^\top x \quad \text{(forward)}, \quad x = U \hat{x} \quad \text{(inverse)}
$$

Spectral convolution on graphs:

$$
x *_G g = U \left(U^\top x \odot U^\top g\right) = U \, \text{diag}(\hat{g}) \, U^\top x
$$

This is the graph analogue of the convolution theorem (convolution in the spatial domain = multiplication in the frequency domain).

## Message Passing Framework

Most GNNs follow the **message passing** paradigm. At each layer $l$:

$$
m_i^{(l)} = \bigoplus_{j \in \mathcal{N}(i)} \phi^{(l)}(h_i^{(l)}, h_j^{(l)}, e_{ij})
$$

$$
h_i^{(l+1)} = \psi^{(l)}(h_i^{(l)}, m_i^{(l)})
$$

where $\bigoplus$ is a permutation-invariant aggregation (sum, mean, max), $\phi$ computes messages, and $\psi$ updates node representations.

## GCN and GAT

**Graph Convolutional Network (GCN)** (Kipf & Welling, 2017):

$$
H^{(l+1)} = \sigma\left(\tilde{D}^{-1/2} \tilde{A} \tilde{D}^{-1/2} H^{(l)} W^{(l)}\right)
$$

where $\tilde{A} = A + I$ (add self-loops) and $\tilde{D}_{ii} = \sum_j \tilde{A}_{ij}$.

**Graph Attention Network (GAT)** (Velickovic et al., 2018) -- learned attention weights:

$$
\alpha_{ij} = \frac{\exp(\text{LeakyReLU}(a^\top [W h_i \| W h_j]))}{\sum_{k \in \mathcal{N}(i)} \exp(\text{LeakyReLU}(a^\top [W h_i \| W h_k]))}
$$

$$
h_i' = \sigma\left(\sum_{j \in \mathcal{N}(i)} \alpha_{ij} W h_j\right)
$$

| Model | Aggregation | Weights | Complexity per node |
|-------|-------------|---------|-------------------|
| GCN | Weighted mean (fixed) | Degree-normalized | $O(d^2)$ |
| GAT | Attention (learned) | Data-dependent | $O(d^2 + d)$ |
| GraphSAGE | Sample + aggregate | Various | $O(kd^2)$ |

## Over-Smoothing

As GNN depth increases, node representations converge to a common vector:

$$
\lim_{L \to \infty} (\tilde{D}^{-1/2} \tilde{A} \tilde{D}^{-1/2})^L = \text{rank-1 matrix}
$$

**Key insight:** Message passing is essentially Laplacian smoothing. Too many layers cause all nodes to have the same representation, losing discriminative power. Solutions include residual connections, dropout on edges, and limiting depth to 2-4 layers.

## Notation Summary

| Symbol | Meaning |
|--------|---------|
| $G = (V, E)$ | Graph with vertices and edges |
| $A$ | Adjacency matrix |
| $D$ | Degree matrix |
| $L$ | Graph Laplacian |
| $\mathcal{N}(i)$ | Neighbors of node $i$ |
| $h_i^{(l)}$ | Node $i$ representation at layer $l$ |
| $\alpha_{ij}$ | Attention coefficient (GAT) |
| $\bigoplus$ | Aggregation function |
