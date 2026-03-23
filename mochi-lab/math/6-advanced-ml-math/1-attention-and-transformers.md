---
sidebar_position: 1
---

# Attention and Transformers

The Transformer architecture [@vaswani2017attention] has become the dominant neural network design for language modeling, vision, and increasingly all of machine learning. Its core innovation -- the attention mechanism -- replaces sequential processing (RNNs) with parallel global interactions, enabling efficient training on modern hardware. This chapter covers the mathematical foundations of attention, the full Transformer architecture, and the computational considerations that dominate modern LLM systems.

## Scaled Dot-Product Attention

<Definition id="def-attention" name="Scaled Dot-Product Attention">
Given queries $Q \in \mathbb{R}^{n \times d_k}$, keys $K \in \mathbb{R}^{m \times d_k}$, and values $V \in \mathbb{R}^{m \times d_v}$ [@vaswani2017attention]:

<Equation id="eq-attention">

$$\text{Attention}(Q, K, V) = \text{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V$$

</Equation>

where $d_k$ is the dimension of the keys. The output is a weighted sum of value vectors, where the weight for each key-value pair is the softmax-normalized dot product between the query and key.
</Definition>

<Remark id="rmk-attention-scaling">
**Why $\sqrt{d_k}$ scaling?** If query and key entries are i.i.d. with mean 0 and variance 1, then $q^\top k = \sum_{i=1}^{d_k} q_i k_i$ has mean 0 and variance $d_k$ (sum of $d_k$ products of unit-variance terms). For large $d_k$, the dot products can be very large in magnitude, pushing the softmax into regions where the gradient is near zero. Dividing by $\sqrt{d_k}$ normalizes the variance to 1, keeping the softmax in its sensitive regime.

Without scaling, with $d_k = 128$, the dot products would have standard deviation $\approx 11$, and softmax$(11, -11) \approx (1, 0)$ -- almost all attention weight on one key. With scaling, std $\approx 1$, and the attention distribution remains informative.
</Remark>

<Remark id="rmk-attention-as-retrieval">
**Attention as soft dictionary lookup.** Attention can be understood as a differentiable key-value lookup:

1. **Query-key matching:** $QK^\top$ computes similarity scores between each query and all keys (like looking up a key in a dictionary).
2. **Normalization:** Softmax converts scores to a probability distribution (soft selection instead of hard lookup).
3. **Value retrieval:** Multiply attention weights by values to get a weighted sum (the "retrieved" information).

This is analogous to a hash table with soft collisions: instead of returning one value for a query, it returns a convex combination of all values, weighted by key similarity. The weights $W^Q, W^K, W^V$ are learned to make the "dictionary" useful for the task.
</Remark>

<Remark id="rmk-attention-kernel">
**Attention as kernel smoothing.** Attention can be written as:

$$\text{Attn}(q_i) = \frac{\sum_j \exp(q_i^\top k_j / \sqrt{d_k}) \cdot v_j}{\sum_j \exp(q_i^\top k_j / \sqrt{d_k})} = \sum_j \frac{\kappa(q_i, k_j)}{\sum_{j'} \kappa(q_i, k_{j'})} v_j$$

where $\kappa(q, k) = \exp(q^\top k / \sqrt{d_k})$ is the softmax kernel. This is a Nadaraya-Watson kernel regression estimator with an exponential kernel. Linear attention variants [@katharopoulos2020transformers] replace the softmax kernel with a decomposable kernel $\kappa(q, k) = \phi(q)^\top \phi(k)$, reducing complexity from $O(n^2)$ to $O(n)$.
</Remark>

## Multi-Head Attention

<Definition id="def-multihead" name="Multi-Head Attention">
Instead of one attention function with $d$-dimensional keys/values, project into $h$ independent heads:

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
**Why multiple heads?** Each head can attend to different aspects of the input:

- **Head specialization:** Empirically, different heads learn to focus on syntactic structure, semantic similarity, positional proximity, or specific linguistic patterns (e.g., subject-verb agreement, coreference).
- **Rank argument:** Single-head attention with softmax output is approximately rank-1 (each query produces a peaked distribution over keys). Multi-head attention can attend to multiple positions simultaneously, achieving higher effective rank. With $h$ heads, the combined attention matrix has rank up to $h$.
- **Information routing:** The output projection $W^O$ learns to combine head outputs, effectively routing different types of information through different subspaces.

Grouped-Query Attention (GQA) [@ainslie2023gqa] uses fewer key-value heads than query heads (e.g., 8 KV heads for 32 query heads), reducing KV-cache memory while maintaining most of the quality.
</Remark>

## The Transformer Block

<Definition id="def-transformer-block" name="Transformer Block">
A single Transformer block applies multi-head attention followed by a position-wise feed-forward network, with residual connections and layer normalization:

<Equation id="eq-transformer-block">

$$x' = \text{LayerNorm}(x + \text{MultiHead}(x, x, x)) \quad \text{(self-attention)}$$
$$\text{out} = \text{LayerNorm}(x' + \text{FFN}(x')) \quad \text{(feed-forward)}$$

</Equation>

where $\text{FFN}(x) = \text{activation}(xW_1 + b_1)W_2 + b_2$ with hidden dimension typically $4d$. Modern LLMs use SwiGLU activation [@shazeer2020glu]: $\text{FFN}(x) = (\text{Swish}(xW_1) \odot xW_3)W_2$ with hidden dimension $\frac{8d}{3}$ (rounded to a multiple of 256).
</Definition>

<Table id="tab-transformer-variants" caption="Transformer architectural variants.">

| Component | Original [@vaswani2017attention] | Modern LLMs (LLaMA-style) |
|-----------|---------|-----------|
| Normalization | Post-LayerNorm | Pre-RMSNorm |
| Activation | ReLU | SwiGLU |
| Position encoding | Sinusoidal (absolute) | RoPE (relative) |
| Attention | MHA ($h$ KV heads) | GQA (fewer KV heads) |
| FFN hidden dim | $4d$ | $\frac{8d}{3}$ (with gate) |
| Bias | Yes | No |
| Dropout | Yes | No (at scale) |
| Vocab embedding | Separate input/output | Tied input/output |

</Table>

<Remark id="rmk-pre-vs-post-norm">
**Pre-norm vs. post-norm.** The original Transformer uses post-norm: $\text{LN}(x + \text{Sublayer}(x))$. Modern LLMs use pre-norm: $x + \text{Sublayer}(\text{LN}(x))$. Pre-norm is more stable during training because the residual stream is not normalized, allowing gradients to flow unchanged through skip connections. The tradeoff: pre-norm can lead to representation collapse in very deep networks (the residual dominates the sublayer output), which is mitigated by proper initialization scaling.
</Remark>

## Positional Encoding

Transformers are permutation-equivariant without positional information: if you permute the input tokens, the output is permuted in the same way. Positional encodings break this symmetry.

**Sinusoidal** (absolute) [@vaswani2017attention]:

<Equation id="eq-sinusoidal-pe">

$$PE_{(pos, 2i)} = \sin\left(\frac{pos}{10000^{2i/d}}\right), \quad PE_{(pos, 2i+1)} = \cos\left(\frac{pos}{10000^{2i/d}}\right)$$

</Equation>

Each dimension oscillates at a different frequency, creating a unique "fingerprint" for each position. The key property: $PE_{pos+k}$ can be written as a linear function of $PE_{pos}$, so the model can learn to attend to relative positions.

**Rotary Position Embeddings (RoPE)** [@su2024rope]: Encode position by rotating the query and key vectors in 2D subspaces:

<Equation id="eq-rope">

$$f(x_m, m) = R_m x_m, \quad R_m = \begin{pmatrix} \cos(m\theta) & -\sin(m\theta) \\ \sin(m\theta) & \cos(m\theta) \end{pmatrix}$$

</Equation>

applied independently to pairs of dimensions. Different pairs use different base frequencies: $\theta_i = 10000^{-2i/d}$.

<Remark id="rmk-rope-properties">
**RoPE advantages:**

- **Relative position:** The dot product $f(q, m)^\top f(k, n) = q^\top R_{m-n} k$ depends only on the relative position $m - n$, not absolute positions.
- **Decay with distance:** The inner product naturally decays with distance for most query-key pairs, implementing a soft locality bias.
- **Length generalization:** RoPE can extrapolate to longer sequences than seen during training, especially with techniques like NTK-aware scaling, YaRN [@peng2023yarn], or dynamic NTK interpolation.
- **No additional parameters:** RoPE modifies the attention computation directly, adding no trainable parameters.
</Remark>

<Remark id="rmk-alibi">
**ALiBi (Attention with Linear Biases)** [@press2022train] adds a linear position-dependent bias directly to the attention scores: $\text{score}(q_i, k_j) = q_i^\top k_j - m \cdot |i - j|$, where $m$ is a head-specific slope. This is simpler than RoPE and also supports length extrapolation, but RoPE has become the dominant choice in modern LLMs.
</Remark>

## Complexity and KV-Cache

Self-attention has $O(n^2 d)$ time complexity and $O(n^2 + nd)$ space for sequence length $n$. During autoregressive generation, the **KV-cache** avoids recomputing previous keys and values:

<Table id="tab-attention-complexity" caption="Attention computation costs during prefill and decode.">

| Phase | Computation | Memory | Bottleneck |
|-------|-------------|--------|------------|
| Prefill (prompt) | $O(n^2 d)$ FLOPs | $O(nd)$ for KV-cache | Compute-bound (matmul) |
| Each decode step | $O(nd)$ per token | KV-cache grows by $2d$ per layer per token | Memory-bound (KV-cache read) |
| Total decode ($T$ tokens) | $O(nTd)$ | $O((n+T)Ld)$ | KV-cache capacity |

</Table>

<Remark id="rmk-kv-cache-memory">
**KV-cache memory dominates inference cost.** For a model with $L$ layers, $h$ heads, key dimension $d_k$, sequence length $n$, and batch size $B$:

$$\text{KV-cache memory} = 2 \times B \times L \times n \times h \times d_k \times \text{bytes per element}$$

For LLaMA-70B ($L = 80$, $h_{kv} = 8$, $d_k = 128$) at $n = 4096$, $B = 1$, in FP16:

$$2 \times 1 \times 80 \times 4096 \times 8 \times 128 \times 2 = 1.34 \text{ GB}$$

At $n = 128K$, this grows to $\sim 42$ GB -- often exceeding the model weights themselves. This is why KV-cache compression (quantization, eviction, paged attention) is critical for long-context inference.
</Remark>

## FlashAttention

<Definition id="def-flash-attention" name="FlashAttention">
**FlashAttention** [@dao2022flashattention] computes exact attention with $O(n^2 d)$ FLOPs but only $O(n)$ extra memory by tiling the computation to exploit the GPU memory hierarchy:

1. **Tiling:** Divide $Q$, $K$, $V$ into blocks of size $B_r \times d$ and $B_c \times d$ that fit in SRAM (on-chip shared memory, typically 192KB per SM on H100).
2. **Online softmax:** For each $Q$ block, iterate over $K$, $V$ blocks, maintaining running softmax statistics (max and sum of exponentials) using the online softmax trick: $m_{\text{new}} = \max(m_{\text{old}}, m_{\text{block}})$, then rescale partial sums.
3. **No materialization:** The $n \times n$ attention matrix is never stored in HBM -- each block is computed in SRAM, used immediately, and discarded.

The IO complexity drops from $O(n^2)$ HBM reads/writes (standard attention) to $O(n^2 d^2 / M)$ where $M$ is SRAM size.
</Definition>

<Remark id="rmk-flash-attention-implications">
**FlashAttention does not change the math** -- it computes the exact same result as standard attention. The speedup (2-4x on A100, more on H100) comes entirely from reducing HBM memory traffic. Key implications:

- **Enables long contexts:** Without FlashAttention, $n = 128K$ requires $128K^2 \times 2 = 32$ GB just for the attention matrix in FP16. FlashAttention needs only $O(n)$ extra memory.
- **Backward pass:** FlashAttention recomputes the attention matrix during the backward pass rather than storing it, trading computation for memory. This is a form of gradient checkpointing applied specifically to attention.
- **FlashAttention-2** [@dao2023flashattention2] further optimizes parallelism across sequence length (not just batch and heads), achieving closer to peak GPU throughput.
- **FlashAttention-3** targets Hopper architecture features (TMA, FP8, warp-specialized kernels).
</Remark>

## Efficient Attention Variants

<Table id="tab-efficient-attention" caption="Approaches to reducing attention complexity.">

| Method | Complexity | Exact? | Key Idea |
|--------|-----------|--------|----------|
| Standard attention | $O(n^2 d)$ | Yes | Full pairwise computation |
| FlashAttention | $O(n^2 d)$ FLOPs, $O(n)$ memory | Yes | Memory-efficient tiling |
| Linear attention [@katharopoulos2020transformers] | $O(nd^2)$ | No | Replace softmax with $\phi(q)\phi(k)^\top$ |
| Sparse attention [@child2019generating] | $O(n\sqrt{n}d)$ | No | Attend only to local + strided positions |
| Ring attention [@liu2023ring] | $O(n^2 d)$ FLOPs, distributed | Yes | Distribute sequence across devices |
| Multi-query attention [@shazeer2019fast] | $O(n^2 d)$ | Yes | Share KV heads across query heads |
| Grouped-query attention [@ainslie2023gqa] | $O(n^2 d)$ | Yes | Few KV head groups, each shared |
| Sliding window [@beltagy2020longformer] | $O(nwd)$ | No | Each token attends to $w$ neighbors |

</Table>

<Remark id="rmk-attention-trends">
**The trend in efficient attention.** Rather than reducing the $O(n^2)$ complexity (which typically sacrifices quality), modern systems focus on:

1. **Making $O(n^2)$ faster:** FlashAttention, hardware-aware implementations.
2. **Reducing KV-cache memory:** GQA, MQA, KV-cache quantization (e.g., FP8 KV), PagedAttention for serving.
3. **Hybrid architectures:** Combine local attention (sliding window) with sparse global attention, or interleave attention layers with linear recurrence layers (e.g., Mamba, RWKV).
4. **Context extension:** RoPE scaling, YaRN, and continued pretraining to extend context from 4K to 128K+ tokens.
</Remark>

## The Complete Transformer

<Remark id="rmk-parameter-count">
**Parameter count of a Transformer.** For a model with $L$ layers, dimension $d$, $h$ heads, vocabulary size $V$, and FFN hidden dim $d_{\text{ff}}$:

| Component | Parameters per layer | Total |
|-----------|---------------------|-------|
| Self-attention ($W^Q, W^K, W^V, W^O$) | $4d^2$ (with MHA) | $4Ld^2$ |
| FFN ($W_1, W_2$) | $2d \cdot d_{\text{ff}}$ | $2Ld \cdot d_{\text{ff}}$ |
| FFN with SwiGLU ($W_1, W_2, W_3$) | $3d \cdot d_{\text{ff}}$ | $3Ld \cdot d_{\text{ff}}$ |
| LayerNorm / RMSNorm | $d$ or $2d$ | $\sim 2Ld$ |
| Embedding + LM head | $Vd$ (tied) | $Vd$ |

For LLaMA-7B ($L=32, d=4096, d_{\text{ff}}=11008, V=32000$): $\approx 6.7B$ parameters. The dominant cost is the FFN (with SwiGLU), followed by attention projections.
</Remark>

## Notation Summary

<Table id="tab-notation-attention" caption="Notation used in this chapter.">

| Symbol | Meaning |
|--------|---------|
| $Q, K, V$ | Query, key, value matrices |
| $d_k, d_v$ | Key and value dimensions per head |
| $h$ | Number of attention heads |
| $n$ | Sequence length |
| $d$ | Model dimension (hidden size) |
| $d_{\text{ff}}$ | Feed-forward hidden dimension |
| $L$ | Number of Transformer layers |
| $W^Q, W^K, W^V, W^O$ | Attention projection matrices |
| $W_1, W_2, W_3$ | FFN weight matrices |
| RoPE | Rotary position embeddings |
| GQA | Grouped-query attention |
| MQA | Multi-query attention |
| $M$ | SRAM (shared memory) size |
| KV-cache | Stored keys and values for autoregressive decoding |

</Table>
