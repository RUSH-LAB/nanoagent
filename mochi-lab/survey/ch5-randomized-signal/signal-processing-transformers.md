---
sidebar_position: 10
title: "Signal Processing View of Transformers"
---

# Signal Processing View of Transformers

### Attention as Adaptive Filtering

Self-attention can be viewed as a form of adaptive filtering: given input tokens, attention computes data-dependent filter coefficients (attention weights) that determine how information from different positions is combined [@dong2021attention, @cordonnier2020relationship]. From this perspective:

- **Query-key dot products** compute similarity, analogous to matched filtering
- **Softmax normalization** creates a probability distribution over positions, analogous to a normalized filter response
- **Value aggregation** is a weighted sum, analogous to applying the computed filter

This interpretation connects attention to a rich literature on adaptive signal processing, including Wiener filters, Kalman filters, and beamforming [@haykin2002adaptive].

### Positional Encoding as Frequency Representation

Sinusoidal positional encodings [@vaswani2017attention] represent position as a combination of sinusoids at different frequencies, directly analogous to a Fourier basis representation. The choice of frequency range determines the length scales the model can distinguish. Rotary Position Embedding (RoPE) [@su2024roformer] extends this by applying rotation matrices to queries and keys, encoding relative position through the interference pattern of complex exponentials -- a technique with close parallels to frequency-domain signal processing. The Long Range Arena benchmark [@tay2021long] has been instrumental in evaluating how different architectures handle long-range dependencies, revealing fundamental differences between attention-based, convolution-based, and recurrence-based approaches from a signal processing perspective.

### Token Mixing as Convolution

Many efficient Transformer alternatives replace attention with fixed or learned convolution-like operations. From a signal processing perspective, these methods trade the adaptivity of attention (data-dependent filters) for the efficiency of convolution (shared, shift-invariant filters) [@leethorp2022fnet, @gu2024mamba]:

- **FNet** [@leethorp2022fnet]: Uses the DFT, a specific linear convolution in the frequency domain
- **gMLP** [@liu2021pay]: Uses spatial gating units, a form of element-wise multiplication in a projected space
- **Hyena** [@poli2023hyena]: Uses data-controlled long convolutions, bridging adaptive attention and fixed convolution

This progression from fixed convolution to data-dependent filtering exactly mirrors the classical signal processing hierarchy from FIR filters to adaptive filters.

### Randomized Attention Approximations

The connection between attention and random features has spawned a family of efficient attention mechanisms that use randomized algorithms from Section 5.4:

**Performer** (Choromanski et al., 2021) [@choromanski2021rethinking] replaces the softmax attention kernel with **FAVOR+** (Fast Attention Via positive Orthogonal Random features). The key insight is that softmax attention can be decomposed as a kernel function: Attention(Q,K) = exp(QK^T/sqrt(d)), and this kernel can be approximated using random features (via the Random Fourier Features framework of Rahimi and Recht). FAVOR+ uses positive orthogonal random features to achieve O(n) attention computation (linear in sequence length) with provable approximation guarantees. Performer matches standard Transformer quality on many tasks while being 2-4x faster for long sequences.

**Reformer** (Kitaev et al., 2020) [@kitaev2020reformer] uses **locality-sensitive hashing (LSH)** (from Section 5.5) to identify the most relevant key-value pairs for each query, reducing attention from O(n^2) to O(n log n). The idea is that for each query, only a small number of keys have significant attention weight (attention is typically sparse), and LSH can efficiently identify these high-attention keys without computing all dot products. Reformer also introduces reversible residual connections (from Section 5.3 of this chapter, connecting to memory-efficient computation) to reduce memory usage from O(nL) to O(n).

**Random Feature Attention (RFA)** (Peng et al., 2021) [@peng2021rfa] uses random features to approximate causal attention, enabling linear-time autoregressive inference. Unlike Performer (which uses a fixed random feature map), RFA learns the random feature distribution, improving approximation quality for the specific attention patterns that arise in practice. **Linear Attention** (Katharopoulos et al., 2020) [@katharopoulos2020transformers] provides the theoretical foundation for these approaches, showing that attention can be decomposed as phi(Q) * (phi(K)^T * V) for any feature map phi, enabling O(n) computation when the feature dimension is small. This decomposition is the bridge between the random features literature and efficient attention: choosing phi to be random Fourier features recovers an approximation to softmax attention.

These methods represent a direct application of the randomized algorithms toolkit (random projections, random features, LSH) to the central computational bottleneck of modern AI (attention), demonstrating the practical value of the theoretical foundations covered in this chapter.
