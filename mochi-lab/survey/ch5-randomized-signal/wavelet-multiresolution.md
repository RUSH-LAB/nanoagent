---
sidebar_position: 9
title: "Wavelet & Multi-Resolution Analysis"
---

# Wavelet & Multi-Resolution Analysis

### Wavelet Scattering Networks

Mallat (2012) [@mallat2012group] introduced the scattering transform, which cascades wavelet transforms with modulus nonlinearities to create representations that are invariant to translations, stable to deformations, and preserve high-frequency discriminative information. Unlike learned convolutions, scattering transforms use predefined wavelets, providing mathematical guarantees on invariance and stability.

Scattering networks have proven effective as feature extractors, especially in low-data regimes where learned features overfit. They also serve as a theoretical framework for understanding what convolutional neural networks learn: deep CNNs can be viewed as learning improved versions of scattering transforms [@bruna2013invariant].

### Multi-Scale Representations

Multi-resolution analysis -- processing signals at multiple scales simultaneously -- is a central concept in both wavelet theory and modern neural network design [@daubechies1992ten]. The fundamental idea is that signals contain information at multiple scales: an image has both coarse structure (overall composition, large objects) and fine detail (textures, edges, small features). Processing at a single scale inevitably loses information at other scales.

In neural networks, multi-resolution processing appears in many forms:
- **U-Net architectures:** The encoder-decoder structure with skip connections implements a form of multi-resolution analysis, processing features at progressively coarser scales in the encoder and reconstructing fine-scale features in the decoder using skip connections from corresponding encoder levels.
- **Feature pyramid networks (FPN):** Build multi-scale feature representations by combining features from different depths of a convolutional backbone, with lateral connections enabling top-down propagation of semantic information.
- **Multi-scale attention:** Attention mechanisms that operate at different scales, either through pooling (reducing the spatial resolution of keys and values for efficient long-range attention) or through hierarchical processing (Swin Transformer's shifted window attention).

The wavelet perspective provides theoretical tools (approximation theory, Besov spaces) for understanding when and why multi-scale representations are beneficial [@mallat2008wavelet]. Specifically, the approximation theory of wavelets shows that functions with localized singularities (edges, discontinuities) are best represented in wavelet bases, which provide sparse representations -- a mathematical explanation for why multi-scale architectures are effective for images with sharp features.

### WaveMix

Jeevan and Sethi (2022) [@jeevan2022wavemix] proposed WaveMix, which uses 2D discrete wavelet transforms for token mixing in vision architectures. WaveMix decomposes feature maps into multi-resolution subbands using wavelets, processes each subband, and reconstructs the mixed features. This achieves competitive performance with CNNs and Vision Transformers while being more parameter-efficient, demonstrating that classical signal processing operators can serve as effective neural network components.

### Wavelet-Integrated Deep Networks

A growing body of work integrates wavelet transforms into deep network architectures for tasks including image super-resolution, denoising, generation, and compression [@liu2025wavelet]. Wavelets provide lossless, invertible decompositions that help networks operate at appropriate scales, reduce spatial resolution without information loss, and inject inductive biases about multi-scale structure.
