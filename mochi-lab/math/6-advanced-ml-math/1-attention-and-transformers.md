---
sidebar_position: 1
---

# Attention and Transformers

## Scaled Dot-Product Attention

<Definition id="def-attention" name="Scaled Dot-Product Attention">
Given queries $Q$, keys $K$, and values $V$ (all matrices where each row is a vector) [@vaswani2017attention]:

<Equation id="eq-attention">

$$\text{Attention}(Q, K, V) = \text{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V$$

</Equation>

where $d_k$ is the dimension of the keys. The $\sqrt{d_k}$ scaling prevents the dot products from becoming too large, which would push the softmax into saturated regions with near-zero gradients.
</Definition>

<Remark id="rmk-attention-scaling">
Without the $\sqrt{d_k}$ scaling, when $d_k$ is large, the dot products $q^\top k$ have variance proportional to $d_k$ (if $q, k$ have unit-variance entries). Dividing by $\sqrt{d_k}$ normalizes the variance to 1, keeping the softmax in its sensitive region.
</Remark>

## Multi-Head Attention

<Definition id="def-multihead" name="Multi-Head Attention">
Instead of one attention function with $d$-dimensional keys/values, project into $h$ heads:

<Equation id="eq-multihead">

$$\text{MultiHead}(Q, K, V) = \text{Concat}(\text{head}_1, \dots, \text{head}_h) W^O$$

</Equation>

$$
\text{head}_i = \text{Attention}(Q W_i^Q, K W_i^K, V W_i^V)
$$

where $W_i^Q \in \mathbb{R}^{d \times d_k}$, $W_i^K \in \mathbb{R}^{d \times d_k}$, $W_i^V \in \mathbb{R}^{d \times d_v}$, and $W^O \in \mathbb{R}^{hd_v \times d}$.
</Definition>

Typically $d_k = d_v = d / h$, so the total computation is the same as single-head attention with full dimensionality.

<Remark id="rmk-multihead-diversity">
Each head can attend to different aspects of the input (e.g., syntactic structure, semantic similarity, positional proximity). The multi-head mechanism allows the model to jointly attend to information from different representation subspaces.
</Remark>

## Positional Encoding

Transformers are permutation-equivariant without positional information. Two main approaches:

**Sinusoidal** [@vaswani2017attention]:

<Equation id="eq-sinusoidal-pe">

$$PE_{(pos, 2i)} = \sin\left(\frac{pos}{10000^{2i/d}}\right), \quad PE_{(pos, 2i+1)} = \cos\left(\frac{pos}{10000^{2i/d}}\right)$$

</Equation>

**Rotary Position Embeddings (RoPE)** [@su2024rope]: Encode position by rotating the query and key vectors:

<Equation id="eq-rope">

$$f(x_m, m) = R_m x_m, \quad R_m = \begin{pmatrix} \cos(m\theta) & -\sin(m\theta) \\ \sin(m\theta) & \cos(m\theta) \end{pmatrix}$$

</Equation>

applied to pairs of dimensions. The dot product $f(q, m)^\top f(k, n)$ depends only on the relative position $m - n$.

<Remark id="rmk-rope-relative">
RoPE encodes relative positions through the geometry of rotations, enabling length generalization without explicit position limits. The rotation angle decreases for higher-frequency dimensions, creating a multi-scale position encoding.
</Remark>

## Complexity and KV-Cache

Self-attention has $O(n^2 d)$ time and $O(n^2)$ space complexity for sequence length $n$. During autoregressive generation, the **KV-cache** avoids recomputing previous keys and values:

<Table id="tab-attention-complexity" caption="Attention computation costs during prefill and decode.">

| Phase | Computation | Memory |
|-------|-------------|--------|
| Prefill | $O(n^2 d)$ | $O(nd)$ for KV-cache |
| Each decode step | $O(nd)$ per token | KV-cache grows by $O(d)$ per token |

</Table>

Total KV-cache memory for $L$ layers, $h$ heads, $n$ tokens: $2 \times L \times h \times n \times d_k$ (2 for K and V).

## FlashAttention

<Definition id="def-flash-attention" name="FlashAttention">
**FlashAttention** [@dao2022flashattention] computes exact attention with $O(n^2 d)$ FLOPs but only $O(n)$ memory by tiling the computation:

1. Divide $Q$, $K$, $V$ into blocks that fit in SRAM (shared memory)
2. For each block, compute partial softmax using the online softmax trick
3. Accumulate the output in SRAM without materializing the $n \times n$ attention matrix

The IO complexity drops from $O(n^2 d)$ (standard) to $O(n^2 d^2 / M)$ where $M$ is SRAM size.
</Definition>

<Remark id="rmk-flash-attention">
FlashAttention does not change the math -- it computes the same result as standard attention. The speedup comes entirely from better use of the memory hierarchy: keeping data in fast SRAM instead of slow HBM.
</Remark>

## Notation Summary

<Table id="tab-notation-attention" caption="Notation used in attention and transformers.">

| Symbol | Meaning |
|--------|---------|
| $Q, K, V$ | Query, key, value matrices |
| $d_k, d_v$ | Key and value dimensions |
| $h$ | Number of attention heads |
| $n$ | Sequence length |
| $d$ | Model dimension |
| $W^Q, W^K, W^V, W^O$ | Projection matrices |
| RoPE | Rotary position embeddings |
| $M$ | SRAM (shared memory) size |

</Table>
