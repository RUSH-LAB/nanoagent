---
sidebar_position: 8
title: "Fourier & Spectral Perspectives"
---

# Fourier & Spectral Perspectives

### Fourier Features for Neural Networks

Tancik et al. (2020) [@tancik2020fourier] demonstrated that standard neural networks fail to learn high-frequency functions from low-dimensional inputs due to a spectral bias toward low frequencies (the "frequency bias" or "spectral bias") [@rahaman2019spectral]. Their solution -- mapping inputs through random Fourier features before feeding them to the network -- enables learning of high-frequency content. This was transformative for Neural Radiance Fields (NeRF) and other coordinate-based neural representations, where fine geometric and appearance details require high-frequency function approximation.

The connection to random features (Section 5.4.2) is direct: Fourier feature mappings are instances of random feature maps for the RBF kernel, and the frequency distribution of the random features controls the bandwidth of learnable functions [@tancik2020fourier].

### Spectral Analysis of Attention

Self-attention can be analyzed through a spectral lens. The attention matrix, when viewed as a linear operator, has a spectrum that reveals the information flow patterns in the network [@bhojanapalli2020low]. Low-rank approximations of attention matrices (motivated by empirical observations of spectral decay) underlie many efficient attention methods. The connection between attention and kernel methods [@tsai2019transformer] enables the use of random feature approximations for attention (e.g., Performer [@choromanski2021rethinking]), linking back to Rahimi and Recht's work.

### Frequency Bias in Neural Networks

Rahaman et al. (2019) [@rahaman2019spectral] showed that neural networks learn low-frequency components of target functions before high-frequency components -- a phenomenon they called the "spectral bias" or F-principle. This has important implications for architecture design: networks struggle with high-frequency patterns unless explicitly encouraged (via positional encoding, Fourier features, or architectural modifications). Understanding spectral bias helps explain why certain architectures (e.g., those with skip connections or Fourier-based layers) generalize better.

### FNet

Lee-Thorp et al. (2022) [@leethorp2022fnet] proposed FNet, which replaces the self-attention sublayer in Transformers with a simple Fourier transform (unparameterized 2D DFT over the sequence and hidden dimensions). FNet achieves 92% of BERT's accuracy on GLUE while training 80% faster on GPUs and 70% faster on TPUs. This striking result suggests that much of what attention does can be approximated by fixed spectral mixing operations, connecting Transformer architecture to classical signal processing.

### Adaptive Fourier Neural Operators

Guibas et al. (2022) [@guibas2022adaptive] proposed AFNO (Adaptive Fourier Neural Operator), which uses parameterized Fourier transforms as token mixing operations in Transformers. Unlike FNet's fixed FFT, AFNO learns channel-mixing weights in the frequency domain, combining the efficiency of spectral methods with the expressiveness of learned parameters. AFNO has been applied to weather forecasting (FourCastNet) and other scientific computing tasks.
