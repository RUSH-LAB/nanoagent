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

Sinusoidal positional encodings [@vaswani2017attention] represent position as a combination of sinusoids at different frequencies, directly analogous to a Fourier basis representation. The choice of frequency range determines the length scales the model can distinguish. Rotary Position Embedding (RoPE) [@su2024roformer] extends this by applying rotation matrices to queries and keys, encoding relative position through the interference pattern of complex exponentials -- a technique with close parallels to frequency-domain signal processing.

### Token Mixing as Convolution

Many efficient Transformer alternatives replace attention with fixed or learned convolution-like operations. From a signal processing perspective, these methods trade the adaptivity of attention (data-dependent filters) for the efficiency of convolution (shared, shift-invariant filters) [@leethorp2022fnet, @gu2024mamba]:

- **FNet** [@leethorp2022fnet]: Uses the DFT, a specific linear convolution in the frequency domain
- **gMLP** [@liu2021pay]: Uses spatial gating units, a form of element-wise multiplication in a projected space
- **Hyena** [@poli2023hyena]: Uses data-controlled long convolutions, bridging adaptive attention and fixed convolution

This progression from fixed convolution to data-dependent filtering exactly mirrors the classical signal processing hierarchy from FIR filters to adaptive filters.
